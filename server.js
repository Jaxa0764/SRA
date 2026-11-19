'use strict';
/**
 * SmartRestaurant server: HTTP API + admin panel + Socket.IO for the waiter apps.
 *
 *   Waiter app   --POST /api/join-->  server  <--approve--  Admin panel (/admin)
 *   Waiter app   <--Socket.IO(token)-->  server
 *   Table button --POST /iot/event (x-device-key)-->  server
 *
 * Business rules live in core.js. Environment variables:
 *   PORT            default 3000
 *   ADMIN_PASSWORD  admin panel password (if missing, a random one is printed at startup)
 *   DEVICE_KEY      shared key the table-button app sends (default "button-secret")
 *   DATA_FILE       where waiters are saved (default ./data/data.json)
 *   TTL_MS          waiter answer time, default 30000
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { createCore } = require('./core');

const PORT = Number(process.env.PORT || 3000);
const TTL_MS = Number(process.env.TTL_MS || 30000);
const DEVICE_KEY = process.env.DEVICE_KEY || 'button-secret';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'data.json');

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
let generatedPassword = false;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex');
  generatedPassword = true;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- storage (JSON file, atomic write) ------------------------------------------------------
const storage = {
  load() {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      return null;
    }
  },
  save(data) {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      log('could not save data file:', e.message);
    }
  },
};

// ---- core + socket wiring ---------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // behind the HTTPS proxy of the hosting provider
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

const core = createCore({
  ttlMs: TTL_MS,
  storage,
  log,
  notify: (waiterId, event, payload) => io.to(`w:${waiterId}`).emit(event, payload),
  kick: (waiterId) => io.in(`w:${waiterId}`).disconnectSockets(true),
});

// ---- tiny in-memory rate limiter -----------------------------------------------------------------
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return {
    /** counts one hit, returns false when over the limit */
    hit(key) {
      const t = Date.now();
      const arr = (hits.get(key) || []).filter((x) => x > t - windowMs);
      arr.push(t);
      hits.set(key, arr);
      if (hits.size > 5000) hits.clear();
      return arr.length <= max;
    },
    count(key) {
      const t = Date.now();
      return (hits.get(key) || []).filter((x) => x > t - windowMs).length;
    },
  };
}
const joinLimiter = makeLimiter(20, 60 * 1000);
const statusLimiter = makeLimiter(120, 60 * 1000);
const loginFails = makeLimiter(5, 10 * 60 * 1000);

// ---- middleware ----------------------------------------------------------------------------------
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '10kb' }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { index: false }));

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- input helpers --------------------------------------------------------------------------------
const cleanName = (s) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '';
const validDeviceId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(s);

// ---- waiter join flow (public) ----------------------------------------------------------------------
app.post('/api/join', (req, res) => {
  if (!joinLimiter.hit(req.ip)) return res.status(429).json({ error: 'too_many_requests' });
  const { deviceId, name } = req.body || {};
  const n = cleanName(name);
  if (!validDeviceId(deviceId) || n.length < 2) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const r = core.requestJoin({ deviceId, name: n });
  if (r.status === 'ERROR') return res.status(503).json({ error: r.error });
  res.json(r);
});

app.get('/api/join/:deviceId', (req, res) => {
  if (!statusLimiter.hit(req.ip)) return res.status(429).json({ error: 'too_many_requests' });
  if (!validDeviceId(req.params.deviceId)) return res.status(400).json({ error: 'invalid_payload' });
  res.json(core.joinStatus(req.params.deviceId));
});

// ---- table button (device key) -------------------------------------------------------------------------
app.post('/iot/event', (req, res) => {
  const given = Buffer.from(String(req.get('x-device-key') || ''));
  const want = Buffer.from(DEVICE_KEY);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ ok: false, error: 'bad_device_key' });
  }
  const b = req.body || {};
  const tableNumber = Number(b.table_id);
  const clickType = Number(b.click_type);
  const eventId = typeof b.event_id === 'string' ? b.event_id : '';
  if (!Number.isInteger(tableNumber) || tableNumber <= 0 || tableNumber > 9999 ||
      ![1, 3].includes(clickType) || eventId.length < 8 || eventId.length > 64) {
    return res.status(400).json({ ok: false, error: 'invalid_payload' });
  }
  const r = core.ingestButtonEvent({ tableNumber, clickType, eventId });
  log(`button table=${tableNumber} click=${clickType} -> ${r.body.status || r.body.error}`);
  res.status(r.code).json(r.body);
});

// ---- admin API --------------------------------------------------------------------------------------------
const adminSessions = new Map(); // token -> expiresAt
const SESSION_MS = 12 * 60 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

app.post('/admin/api/login', (req, res) => {
  if (loginFails.count(req.ip) >= 5) return res.status(429).json({ error: 'too_many_attempts' });
  const given = sha((req.body || {}).password || '');
  if (!crypto.timingSafeEqual(given, sha(ADMIN_PASSWORD))) {
    loginFails.hit(req.ip);
    return res.status(401).json({ error: 'wrong_password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, Date.now() + SESSION_MS);
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const exp = m && adminSessions.get(m[1]);
  if (!exp || exp < Date.now()) {
    if (m) adminSessions.delete(m[1]);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/admin/api/state', requireAdmin, (req, res) => res.json(core.getState()));

app.post('/admin/api/join/:id/approve', requireAdmin, (req, res) =>
  res.json(core.approveJoin(req.params.id)));
app.post('/admin/api/join/:id/reject', requireAdmin, (req, res) =>
  res.json(core.rejectJoin(req.params.id)));
app.delete('/admin/api/waiters/:id', requireAdmin, (req, res) =>
  res.json(core.removeWaiter(Number(req.params.id))));
app.post('/admin/api/assign', requireAdmin, (req, res) => {
  const { requestId, waiterId } = req.body || {};
  res.json(core.manualAssign({ requestId, waiterId }));
});
app.post('/admin/api/tables/:n/free', requireAdmin, (req, res) => {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'invalid_table' });
  res.json(core.adminFreeTable(n));
});

// ---- error handling -----------------------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  log('error', err);
  res.status(500).json({ error: 'server_error' });
});

// ---- Socket.IO for waiter apps ------------------------------------------------------------------------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const waiter = core.authWaiter(token);
  if (!waiter) return next(new Error('unauthorized'));
  socket.data.waiterId = waiter.id;
  next();
});

io.on('connection', (socket) => {
  const waiterId = socket.data.waiterId;
  socket.join(`w:${waiterId}`);
  core.waiterConnected(waiterId);

  // After a (re)connect the app asks for offers that are still alive.
  socket.on('sync:request', (_payload, ack) => {
    for (const m of core.syncFor(waiterId)) socket.emit(m.event, m.payload);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('waiter:response', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'invalid_payload' });
    try {
      reply(core.handleWaiterResponse(waiterId, payload));
    } catch (e) {
      log('response error', e);
      reply({ ok: false, error: 'server_error' });
    }
  });

  socket.on('disconnect', () => core.waiterDisconnected(waiterId));
});

server.listen(PORT, '0.0.0.0', () => {
  log(`SmartRestaurant server on port ${PORT}`);
  log(`admin panel: /admin`);
  if (generatedPassword) {
    log(`ADMIN_PASSWORD was not set. Temporary admin password: ${ADMIN_PASSWORD}`);
  }
  if (!process.env.DEVICE_KEY) {
    log('DEVICE_KEY not set, using the default "button-secret" (set it in production)');
  }
});
