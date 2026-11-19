(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let token = null;
  try { token = sessionStorage.getItem('adminToken'); } catch (e) { /* storage blocked */ }
  let timer = null;
  const signatures = {}; // section -> last rendered JSON, so we only redraw what changed
  const chosenWaiter = {}; // escalated requestId -> selected waiter id

  // Build DOM safely (names come from users, so never use innerHTML).
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return n;
  }
  const badge = (text, cls) => el('span', { class: `badge ${cls}`, text });
  const clock = (t) => new Date(t).toLocaleTimeString();

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: Object.assign(
        { Authorization: `Bearer ${token}` },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { signOut(); throw new Error('unauthorized'); }
    return res.json();
  }

  // ---- login / logout --------------------------------------------------------------------------
  function showApp(on) {
    $('login').classList.toggle('hidden', on);
    $('app').classList.toggle('hidden', !on);
  }

  function signOut() {
    token = null;
    try { sessionStorage.removeItem('adminToken'); } catch (e) { /* ignore */ }
    clearInterval(timer);
    showApp(false);
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    try {
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('password').value }),
      });
      const data = await res.json();
      if (!res.ok) {
        $('loginError').textContent = res.status === 429
          ? 'Too many attempts. Try again later.' : 'Wrong password.';
        return;
      }
      token = data.token;
      try { sessionStorage.setItem('adminToken', token); } catch (err) { /* ignore */ }
      $('password').value = '';
      start();
    } catch (err) {
      $('loginError').textContent = 'Cannot reach the server.';
    }
  });
  $('logout').addEventListener('click', signOut);

  // ---- rendering --------------------------------------------------------------------------------
  function section(name, data, build) {
    const sig = JSON.stringify(data);
    if (signatures[name] === sig) return;
    signatures[name] = sig;
    const box = $(name);
    box.replaceChildren(...build());
  }

  const empty = (text) => el('div', { class: 'empty', text });

  async function act(method, path, body) {
    try {
      await api(method, path, body);
    } catch (e) { /* 401 handled in api() */ }
    refresh();
  }

  function render(state) {
    const online = state.waiters.filter((w) => w.online).length;
    $('sPending').textContent = state.joinRequests.length;
    $('sOnline').textContent = online;
    $('sTables').textContent = state.tables.filter((t) => t.status === 'OCCUPIED').length;
    $('sEsc').textContent = state.escalated.length;
    document.title = (state.joinRequests.length + state.escalated.length > 0
      ? `(${state.joinRequests.length + state.escalated.length}) ` : '') + 'SmartRestaurant Admin';

    section('joinBox', state.joinRequests, () => {
      $('joinBox').classList.toggle('alert', state.joinRequests.length > 0);
      if (!state.joinRequests.length) return [empty('No waiting requests')];
      return state.joinRequests.map((j) => el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { class: 'name', text: j.name }),
          el('div', { class: 'sub', text: `asked at ${clock(j.createdAt)}` })),
        el('button', { class: 'ok', text: 'Approve',
          onclick: () => act('POST', `/admin/api/join/${encodeURIComponent(j.id)}/approve`) }),
        el('button', { class: 'danger', text: 'Reject',
          onclick: () => act('POST', `/admin/api/join/${encodeURIComponent(j.id)}/reject`) })));
    });

    const onlineWaiters = state.waiters.filter((w) => w.online);
    section('escBox', { esc: state.escalated, onlineWaiters }, () => {
      $('escBox').classList.toggle('alert-bad', state.escalated.length > 0);
      if (!state.escalated.length) return [empty('Nothing escalated')];
      return state.escalated.map((r) => {
        // A new service call needs a free waiter; a help request can go to any online waiter.
        const free = r.type === 'SERVICE'
          ? onlineWaiters.filter((w) => w.status === 'AVAILABLE') : onlineWaiters;
        const select = el('select', {
          onchange: (e) => { chosenWaiter[r.id] = e.target.value; },
        }, ...free.map((w) => el('option', { value: String(w.id), text: w.name })));
        if (chosenWaiter[r.id]) select.value = chosenWaiter[r.id];
        return el('div', { class: 'row' },
          el('div', { class: 'grow' },
            el('div', { class: 'name', text: `Table ${r.table}` }),
            el('div', { class: 'sub', text: r.reason || 'Needs a waiter' })),
          free.length ? select : el('span', { class: 'sub', text: 'No free waiter right now' }),
          el('button', {
            text: 'Assign', disabled: free.length ? null : 'disabled',
            onclick: () => act('POST', '/admin/api/assign',
              { requestId: r.id, waiterId: Number(select.value) }),
          }));
      });
    });

    section('waiterBox', state.waiters, () => {
      if (!state.waiters.length) return [empty('No waiters yet. Approve a join request first.')];
      return state.waiters.map((w) => el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { class: 'name', text: w.name }),
          el('div', { class: 'sub',
            text: w.tables.length ? `Tables: ${w.tables.join(', ')}` : 'No tables' })),
        el('div', {},
          badge(w.online ? 'online' : 'offline', w.online ? 'b-ok' : 'b-grey'),
          w.online ? badge(w.status.toLowerCase(), w.status === 'RESERVED' ? 'b-warn' : 'b-info') : null),
        el('button', { class: 'danger', text: 'Remove', onclick: () => {
          if (confirm(`Remove ${w.name}? Their device will be disconnected.`)) {
            act('DELETE', `/admin/api/waiters/${w.id}`);
          }
        } })));
    });

    section('tableBox', state.tables, () => {
      if (!state.tables.length) return [empty('Tables appear after the first button press')];
      return state.tables.map((t) => el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { class: 'name', text: `Table ${t.number}` }),
          el('div', { class: 'sub', text: t.waiterName ? `Waiter: ${t.waiterName}` : 'No waiter' })),
        badge(t.status.toLowerCase(), t.status === 'FREE' ? 'b-ok' : 'b-warn'),
        t.status === 'OCCUPIED'
          ? el('button', { class: 'ghost', text: 'Mark free',
              onclick: () => act('POST', `/admin/api/tables/${t.number}/free`) })
          : null));
    });

    const typeLabel = { SERVICE: 'call', ASSIST: 'help', CHECKOUT: 'checkout' };
    const statusClass = (s) => (s === 'ACCEPTED' || s === 'CONFIRMED' ? 'b-ok'
      : s === 'ESCALATED' || s === 'REJECTED' || s === 'TIMED_OUT' ? 'b-bad'
      : s === 'PENDING' || s === 'NOTIFIED' ? 'b-warn' : 'b-grey');
    section('reqBox', state.requests, () => {
      if (!state.requests.length) return [empty('No requests yet')];
      return state.requests.map((r) => el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { class: 'name', text: `Table ${r.table} · ${typeLabel[r.type] || r.type}` }),
          el('div', { class: 'sub', text:
            `${clock(r.createdAt)}${r.history.length ? ' · ' + r.history.map(
              (h) => `${h.waiter || '?'}: ${h.result.toLowerCase()}`).join(' → ') : ''}` })),
        badge(r.status.toLowerCase().replace('_', ' '), statusClass(r.status))));
    });

    section('logBox', state.audit, () => {
      if (!state.audit.length) return [el('div', { text: 'Nothing yet' })];
      return state.audit.map((a) => el('div', { text: `${clock(a.t)}  ${a.text}` }));
    });
  }

  // ---- polling ----------------------------------------------------------------------------------
  async function refresh() {
    try {
      const state = await api('GET', '/admin/api/state');
      $('conn').textContent = '';
      render(state);
    } catch (e) {
      if (token) $('conn').textContent = '· connection lost, retrying...';
    }
  }

  function start() {
    showApp(true);
    for (const k of Object.keys(signatures)) delete signatures[k];
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 2000);
  }

  if (token) start(); else showApp(false);
})();
