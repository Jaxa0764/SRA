'use strict';
/**
 * Business logic of the SmartRestaurant MVP. No HTTP and no Socket.IO in here, only rules,
 * so everything can be tested with `npm test` (node --test) and no extra packages.
 *
 * Covers:
 *  - join requests: a waiter app asks to join, the admin approves or rejects, approval creates
 *    a waiter with a secret token
 *  - fair randomized round-robin: every online, AVAILABLE waiter gets one turn per cycle in
 *    random order, then the cycle resets
 *  - single click on a FREE table: offer -> YES / NO / timeout -> next waiter -> escalation
 *  - single click on an OCCUPIED table: only the assigned waiter is told
 *  - triple click: checkout question to the assigned waiter only
 *  - idempotency by event_id, per-table rate limit
 *
 * State is in memory (timers are setTimeout), only waiters and join requests are saved through
 * `storage`. Production plan: MySQL for data, Redis for locks and restart-safe timers.
 */
const crypto = require('crypto');

const MAX_PENDING_JOINS = 50;
const AUDIT_LIMIT = 100;

function createCore(opts = {}) {
  const ttlMs = opts.ttlMs || 30000;
  const storage = opts.storage || { load: () => null, save: () => {} };
  const notify = opts.notify || (() => {}); // (waiterId, event, payload)
  const kick = opts.kick || (() => {}); // (waiterId) -> disconnect that waiter's sockets
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});

  const uid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

  // ---- persistent data ---------------------------------------------------------------------
  const saved = storage.load() || {};
  let nextWaiterId = saved.nextWaiterId || 1;
  /** id -> {id, name, token, deviceId, createdAt, status: AVAILABLE|RESERVED, connections} */
  const waiters = new Map();
  for (const w of saved.waiters || []) {
    waiters.set(w.id, { ...w, status: 'AVAILABLE', connections: 0 });
  }
  /** id -> {id, deviceId, name, status: PENDING|APPROVED|REJECTED, createdAt, waiterId?} */
  const joinRequests = new Map();
  for (const j of saved.joinRequests || []) joinRequests.set(j.id, j);

  // ---- runtime data --------------------------------------------------------------------------
  const tables = new Map(); // number -> {number, status: FREE|OCCUPIED, waiterId}
  const requests = new Map(); // id -> request
  let cycleServed = new Set();
  const processedEvents = new Map(); // event_id -> {at, result}
  const lastTableEvent = new Map();
  const auditLog = [];

  function persist() {
    const finished = [...joinRequests.values()].filter((j) => j.status !== 'PENDING');
    if (finished.length > 100) {
      finished.sort((a, b) => a.createdAt - b.createdAt);
      for (const j of finished.slice(0, finished.length - 100)) joinRequests.delete(j.id);
    }
    storage.save({
      nextWaiterId,
      waiters: [...waiters.values()].map((w) => ({
        id: w.id, name: w.name, token: w.token, deviceId: w.deviceId, createdAt: w.createdAt,
      })),
      joinRequests: [...joinRequests.values()],
    });
  }

  function audit(text) {
    auditLog.push({ t: now(), text });
    while (auditLog.length > AUDIT_LIMIT) auditLog.shift();
    log(text);
  }

  const isOnline = (w) => w.connections > 0;

  function getTable(n) {
    if (!tables.has(n)) tables.set(n, { number: n, status: 'FREE', waiterId: null });
    return tables.get(n);
  }

  // =========================== join requests (waiter <-> admin) ===============================

  function requestJoin({ deviceId, name }) {
    const existing = [...waiters.values()].find((w) => w.deviceId === deviceId);
    if (existing) return { status: 'APPROVED', token: existing.token, name: existing.name };

    let jr = [...joinRequests.values()].find((j) => j.deviceId === deviceId);
    if (jr) {
      jr.status = 'PENDING';
      jr.name = name;
      jr.createdAt = now();
      delete jr.waiterId;
    } else {
      const pending = [...joinRequests.values()].filter((j) => j.status === 'PENDING').length;
      if (pending >= MAX_PENDING_JOINS) return { status: 'ERROR', error: 'too_many_pending' };
      jr = { id: uid('join'), deviceId, name, status: 'PENDING', createdAt: now() };
      joinRequests.set(jr.id, jr);
    }
    persist();
    audit(`Join request from "${name}"`);
    return { status: 'PENDING' };
  }

  function joinStatus(deviceId) {
    const w = [...waiters.values()].find((x) => x.deviceId === deviceId);
    if (w) return { status: 'APPROVED', token: w.token, name: w.name };
    const jr = [...joinRequests.values()].find((j) => j.deviceId === deviceId);
    if (!jr) return { status: 'NONE' };
    return { status: jr.status === 'APPROVED' ? 'REJECTED' : jr.status };
  }

  function approveJoin(joinId) {
    const jr = joinRequests.get(joinId);
    if (!jr || jr.status !== 'PENDING') return { ok: false, error: 'not_pending' };
    const w = {
      id: nextWaiterId++,
      name: jr.name,
      token: crypto.randomBytes(24).toString('hex'),
      deviceId: jr.deviceId,
      createdAt: now(),
      status: 'AVAILABLE',
      connections: 0,
    };
    waiters.set(w.id, w);
    jr.status = 'APPROVED';
    jr.waiterId = w.id;
    persist();
    audit(`Admin approved "${w.name}"`);
    return { ok: true, waiterId: w.id };
  }

  function rejectJoin(joinId) {
    const jr = joinRequests.get(joinId);
    if (!jr || jr.status !== 'PENDING') return { ok: false, error: 'not_pending' };
    jr.status = 'REJECTED';
    persist();
    audit(`Admin rejected "${jr.name}"`);
    return { ok: true };
  }

  function removeWaiter(id) {
    const w = waiters.get(id);
    if (!w) return { ok: false, error: 'not_found' };
    waiters.delete(id);
    for (const jr of joinRequests.values()) {
      if (jr.waiterId === id) jr.status = 'REJECTED';
    }
    for (const t of tables.values()) {
      if (t.waiterId === id) t.waiterId = null;
    }
    // Offers that were waiting for this waiter move on to the next one.
    for (const req of requests.values()) {
      if (req.status !== 'PENDING' || req.waiterId !== id) continue;
      clearTimeout(req.timer);
      req.excluded.add(id);
      req.history.push({ attemptId: req.attemptId, waiterId: id, result: 'WAITER_REMOVED' });
      if (req.type === 'SERVICE') offerToNext(req);
      else req.status = 'CANCELLED';
    }
    persist();
    audit(`Admin removed "${w.name}"`);
    kick(id);
    return { ok: true };
  }

  function authWaiter(token) {
    if (typeof token !== 'string' || token.length < 16) return null;
    for (const w of waiters.values()) {
      const a = Buffer.from(w.token);
      const b = Buffer.from(token);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return w;
    }
    return null;
  }

  function waiterConnected(id) {
    const w = waiters.get(id);
    if (!w) return;
    w.connections++;
    audit(`"${w.name}" is online`);
  }

  function waiterDisconnected(id) {
    const w = waiters.get(id);
    if (!w) return;
    w.connections = Math.max(0, w.connections - 1);
    if (w.connections === 0) audit(`"${w.name}" went offline`);
  }

  // ============================ fair randomized round-robin ===================================

  function eligibleWaiters(excluded) {
    return [...waiters.values()].filter(
      (w) => isOnline(w) && w.status === 'AVAILABLE' && !excluded.has(w.id));
  }

  /**
   * Everyone gets one turn per cycle, in random order. When all eligible waiters have had their
   * turn, the cycle resets. Waiters who join mid-cycle are simply "not served yet"; waiters who
   * leave just stop being candidates, so the cycle never gets corrupted.
   */
  function pickNextWaiter(excluded) {
    const candidates = eligibleWaiters(excluded);
    if (candidates.length === 0) return null;
    let fresh = candidates.filter((w) => !cycleServed.has(w.id));
    if (fresh.length === 0) {
      cycleServed = new Set();
      fresh = candidates;
    }
    const w = fresh[crypto.randomInt(fresh.length)];
    cycleServed.add(w.id);
    return w;
  }

  // ================================ service request flow ======================================

  function newRequest(type, tableNumber, extra = {}) {
    const req = {
      id: uid('req'), type, tableNumber, status: 'PENDING', createdAt: now(),
      excluded: new Set(), attemptId: null, waiterId: null, timer: null, expiresAt: 0,
      reason: '', history: [], ...extra,
    };
    requests.set(req.id, req);
    return req;
  }

  function startAttemptTimer(req) {
    const attemptId = req.attemptId;
    clearTimeout(req.timer);
    req.timer = setTimeout(() => onAttemptTimeout(req.id, attemptId), ttlMs);
    if (req.timer.unref) req.timer.unref();
  }

  function offerToNext(req) {
    const w = pickNextWaiter(req.excluded);
    if (!w) return escalate(req, 'No available waiter accepted the request');

    w.status = 'RESERVED';
    req.waiterId = w.id;
    req.attemptId = uid('att');
    req.expiresAt = now() + ttlMs;
    req.history.push({ attemptId: req.attemptId, waiterId: w.id, result: 'OFFERED' });
    audit(`Table ${req.tableNumber} -> offered to "${w.name}"`);

    notify(w.id, 'waiter:service_offer', {
      requestId: req.id, attemptId: req.attemptId, tableNumber: req.tableNumber, ttlMs,
    });
    startAttemptTimer(req);
  }

  function releaseWaiter(id) {
    const w = waiters.get(id);
    if (w) w.status = 'AVAILABLE';
  }

  function onAttemptTimeout(requestId, attemptId) {
    const req = requests.get(requestId);
    if (!req || req.status !== 'PENDING' || req.attemptId !== attemptId) return;
    const w = waiters.get(req.waiterId);
    notify(req.waiterId, 'waiter:service_timeout', { requestId: req.id, attemptId });
    audit(`Table ${req.tableNumber}: "${w ? w.name : '?'}" did not answer in time`);
    // Checkout questions never reserve the waiter, only service offers do.
    if (req.type === 'SERVICE') releaseWaiter(req.waiterId);
    req.excluded.add(req.waiterId);
    req.history.push({ attemptId, waiterId: req.waiterId, result: 'TIMED_OUT' });
    if (req.type === 'CHECKOUT') {
      req.status = 'TIMED_OUT';
      return;
    }
    offerToNext(req);
  }

  function escalate(req, reason) {
    clearTimeout(req.timer);
    req.status = 'ESCALATED';
    req.waiterId = null;
    req.reason = reason;
    audit(`Table ${req.tableNumber} ESCALATED to admin: ${reason}`);
  }

  // ================================= button events ============================================

  function handleButtonEvent({ tableNumber, clickType }) {
    const table = getTable(tableNumber);

    if (clickType === 1) {
      if (table.status === 'FREE') {
        const pending = [...requests.values()].find(
          (r) => r.type === 'SERVICE' && r.tableNumber === tableNumber &&
                 (r.status === 'PENDING' || r.status === 'ESCALATED'));
        if (pending) return { status: 'ALREADY_PENDING', requestId: pending.id };
        const req = newRequest('SERVICE', tableNumber);
        audit(`Table ${tableNumber}: customer called`);
        offerToNext(req);
        return { status: req.status, requestId: req.id };
      }

      // OCCUPIED: only the assigned waiter is told.
      const w = waiters.get(table.waiterId);
      if (!w || !isOnline(w)) {
        const req = newRequest('ASSIST', tableNumber);
        escalate(req, 'Assigned waiter is offline');
        return { status: 'ESCALATED', requestId: req.id };
      }
      const req = newRequest('ASSIST', tableNumber, { status: 'NOTIFIED', waiterId: w.id });
      audit(`Table ${tableNumber}: needs assistance -> "${w.name}"`);
      notify(w.id, 'table:assistance_request', { requestId: req.id, tableNumber });
      return { status: 'WAITER_NOTIFIED', requestId: req.id };
    }

    if (clickType === 3) {
      if (table.status !== 'OCCUPIED') return { status: 'IGNORED_TABLE_FREE' };
      const w = waiters.get(table.waiterId);
      if (!w || !isOnline(w)) return { status: 'ASSIGNED_WAITER_OFFLINE' };
      const open = [...requests.values()].find(
        (r) => r.type === 'CHECKOUT' && r.tableNumber === tableNumber && r.status === 'PENDING');
      if (open) return { status: 'ALREADY_PENDING', requestId: open.id };

      const req = newRequest('CHECKOUT', tableNumber, {
        attemptId: uid('att'), waiterId: w.id, expiresAt: now() + ttlMs,
      });
      audit(`Table ${tableNumber}: checkout question -> "${w.name}"`);
      notify(w.id, 'table:checkout_confirmation', {
        requestId: req.id, attemptId: req.attemptId, tableNumber, ttlMs,
      });
      startAttemptTimer(req);
      return { status: 'CHECKOUT_ASKED', requestId: req.id };
    }

    return { status: 'UNSUPPORTED_CLICK_TYPE' };
  }

  /** Idempotent entry point for the table button. */
  function ingestButtonEvent({ tableNumber, clickType, eventId }) {
    const seen = processedEvents.get(eventId);
    if (seen) return { code: 200, body: { ok: true, duplicate: true, ...seen.result } };

    const key = `${tableNumber}:${clickType}`;
    const t = now();
    if (t - (lastTableEvent.get(key) || 0) < 2000) {
      return { code: 429, body: { ok: false, error: 'too_many_requests' } };
    }
    lastTableEvent.set(key, t);

    const result = handleButtonEvent({ tableNumber, clickType });
    processedEvents.set(eventId, { at: t, result });
    // forget old ids
    for (const [k, v] of processedEvents) if (v.at < t - 10 * 60 * 1000) processedEvents.delete(k);
    return { code: 200, body: { ok: true, duplicate: false, ...result } };
  }

  // =============================== waiter answers =============================================

  function handleWaiterResponse(waiterId, payload) {
    const waiter = waiters.get(waiterId);
    if (!waiter) return { ok: false, error: 'unknown_waiter' };
    const { requestId, attemptId, kind, decision } = payload || {};
    const req = requests.get(requestId);
    if (!req) return { ok: false, error: 'unknown_request' };
    if (req.status !== 'PENDING') return { ok: false, error: 'request_closed' };
    if (req.attemptId !== attemptId) return { ok: false, error: 'stale_attempt' };
    if (req.waiterId !== waiter.id) return { ok: false, error: 'not_your_request' };
    if (now() > req.expiresAt) return { ok: false, error: 'expired' };
    if ((kind === 'CHECKOUT') !== (req.type === 'CHECKOUT')) return { ok: false, error: 'wrong_kind' };
    if (decision !== 'YES' && decision !== 'NO') return { ok: false, error: 'bad_decision' };

    clearTimeout(req.timer);
    const table = getTable(req.tableNumber);

    if (req.type === 'SERVICE') {
      if (decision === 'YES') {
        table.status = 'OCCUPIED';
        table.waiterId = waiter.id;
        releaseWaiter(waiter.id);
        req.status = 'ACCEPTED';
        req.history.push({ attemptId, waiterId: waiter.id, result: 'ACCEPTED' });
        notify(waiter.id, 'waiter:service_accepted', { requestId: req.id });
        audit(`Table ${req.tableNumber}: accepted by "${waiter.name}"`);
      } else {
        releaseWaiter(waiter.id);
        req.excluded.add(waiter.id);
        req.history.push({ attemptId, waiterId: waiter.id, result: 'REJECTED' });
        notify(waiter.id, 'waiter:service_rejected', { requestId: req.id });
        audit(`Table ${req.tableNumber}: rejected by "${waiter.name}"`);
        offerToNext(req);
      }
    } else if (decision === 'YES') {
      table.status = 'FREE';
      table.waiterId = null;
      req.status = 'CONFIRMED';
      req.history.push({ attemptId, waiterId: waiter.id, result: 'CONFIRMED' });
      notify(waiter.id, 'waiter:checkout_result', { requestId: req.id, result: 'CONFIRMED' });
      audit(`Table ${req.tableNumber}: free again (confirmed by "${waiter.name}")`);
    } else {
      req.status = 'REJECTED';
      req.history.push({ attemptId, waiterId: waiter.id, result: 'REJECTED' });
      notify(waiter.id, 'waiter:checkout_result', { requestId: req.id, result: 'REJECTED' });
    }
    return { ok: true };
  }

  // ================================ admin actions =============================================

  function manualAssign({ requestId, waiterId }) {
    const req = requests.get(requestId);
    const target = waiters.get(Number(waiterId));
    if (!req || req.status !== 'ESCALATED' || !target) return { ok: false, error: 'invalid' };
    if (!isOnline(target)) return { ok: false, error: 'waiter_offline' };

    if (req.type === 'ASSIST') {
      req.status = 'NOTIFIED';
      req.waiterId = target.id;
      notify(target.id, 'table:assistance_request', { requestId: req.id, tableNumber: req.tableNumber });
      audit(`Admin sent table ${req.tableNumber} help request to "${target.name}"`);
      return { ok: true };
    }

    if (target.status !== 'AVAILABLE') return { ok: false, error: 'waiter_busy' };
    req.status = 'PENDING';
    req.excluded = new Set();
    req.reason = '';
    target.status = 'RESERVED';
    req.waiterId = target.id;
    req.attemptId = uid('att');
    req.expiresAt = now() + ttlMs;
    req.history.push({ attemptId: req.attemptId, waiterId: target.id, result: 'ADMIN_ASSIGNED' });
    audit(`Admin assigned table ${req.tableNumber} to "${target.name}"`);
    notify(target.id, 'waiter:service_offer', {
      requestId: req.id, attemptId: req.attemptId, tableNumber: req.tableNumber, ttlMs,
    });
    startAttemptTimer(req);
    return { ok: true };
  }

  /** Admin can force a table back to FREE (customer left, waiter forgot to confirm...). */
  function adminFreeTable(n) {
    const table = getTable(n);
    for (const r of requests.values()) {
      if (r.tableNumber === n && r.status === 'PENDING' && r.type === 'CHECKOUT') {
        clearTimeout(r.timer);
        r.status = 'CANCELLED';
      }
    }
    table.status = 'FREE';
    table.waiterId = null;
    audit(`Admin freed table ${n}`);
    return { ok: true };
  }

  // ================================== views ====================================================

  /** Offers still alive for this waiter, re-sent after a reconnect. */
  function syncFor(waiterId) {
    const out = [];
    for (const r of requests.values()) {
      if (r.status !== 'PENDING' || r.waiterId !== waiterId) continue;
      const left = r.expiresAt - now();
      if (left <= 0) continue;
      out.push({
        event: r.type === 'CHECKOUT' ? 'table:checkout_confirmation' : 'waiter:service_offer',
        payload: { requestId: r.id, attemptId: r.attemptId, tableNumber: r.tableNumber, ttlMs: left },
      });
    }
    return out;
  }

  function getState() {
    const nameOf = (id) => (waiters.has(id) ? waiters.get(id).name : null);
    const reqView = (r) => ({
      id: r.id, type: r.type, table: r.tableNumber, status: r.status, reason: r.reason,
      waiterId: r.waiterId, waiterName: nameOf(r.waiterId), createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      history: r.history.map((h) => ({ result: h.result, waiter: nameOf(h.waiterId) })),
    });
    const all = [...requests.values()].sort((a, b) => b.createdAt - a.createdAt);
    return {
      now: now(),
      ttlMs,
      waiters: [...waiters.values()].map((w) => ({
        id: w.id, name: w.name, status: w.status, online: isOnline(w),
        tables: [...tables.values()].filter((t) => t.waiterId === w.id).map((t) => t.number),
      })),
      joinRequests: [...joinRequests.values()]
        .filter((j) => j.status === 'PENDING')
        .map((j) => ({ id: j.id, name: j.name, createdAt: j.createdAt })),
      tables: [...tables.values()].sort((a, b) => a.number - b.number).map((t) => ({
        number: t.number, status: t.status, waiterId: t.waiterId, waiterName: nameOf(t.waiterId),
      })),
      escalated: all.filter((r) => r.status === 'ESCALATED').map(reqView),
      requests: all.slice(0, 30).map(reqView),
      audit: auditLog.slice(-40).reverse(),
    };
  }

  function shutdown() {
    for (const r of requests.values()) clearTimeout(r.timer);
  }

  return {
    requestJoin, joinStatus, approveJoin, rejectJoin, removeWaiter, authWaiter,
    waiterConnected, waiterDisconnected,
    ingestButtonEvent, handleButtonEvent, handleWaiterResponse,
    manualAssign, adminFreeTable, syncFor, getState, shutdown,
  };
}

module.exports = { createCore };
