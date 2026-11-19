'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Creates a core with n approved, online waiters and records everything sent to them. */
function setup(n, ttlMs = 5000) {
  const sent = []; // {waiterId, event, payload}
  const kicked = [];
  const core = createCore({
    ttlMs,
    notify: (waiterId, event, payload) => sent.push({ waiterId, event, payload }),
    kick: (id) => kicked.push(id),
  });
  const ids = [];
  for (let i = 1; i <= n; i++) {
    core.requestJoin({ deviceId: `device-${i}-xxxxxxxxxxxx`, name: `W${i}` });
  }
  for (const j of core.getState().joinRequests) {
    const r = core.approveJoin(j.id);
    ids.push(r.waiterId);
    core.waiterConnected(r.waiterId);
  }
  return { core, sent, kicked, ids };
}

let evCounter = 0;
const press = (core, table, click) =>
  core.ingestButtonEvent({ tableNumber: table, clickType: click, eventId: `evt-${++evCounter}-padpadpad` });

const lastOffer = (sent) => [...sent].reverse().find((m) => m.event === 'waiter:service_offer');
const answer = (core, offer, decision, kind = 'SERVICE') =>
  core.handleWaiterResponse(offer.waiterId, {
    requestId: offer.payload.requestId, attemptId: offer.payload.attemptId, kind, decision,
  });

test('join flow: pending -> approved -> token works; reject; remove revokes', () => {
  const kicked = [];
  const core = createCore({ kick: (id) => kicked.push(id) });
  assert.equal(core.joinStatus('dev-aaaaaaaaaaaaaaaa').status, 'NONE');
  assert.equal(core.requestJoin({ deviceId: 'dev-aaaaaaaaaaaaaaaa', name: 'Ali' }).status, 'PENDING');
  assert.equal(core.joinStatus('dev-aaaaaaaaaaaaaaaa').status, 'PENDING');
  // no token before approval
  assert.equal(core.joinStatus('dev-aaaaaaaaaaaaaaaa').token, undefined);

  const jr = core.getState().joinRequests[0];
  const ok = core.approveJoin(jr.id);
  assert.equal(ok.ok, true);
  const st = core.joinStatus('dev-aaaaaaaaaaaaaaaa');
  assert.equal(st.status, 'APPROVED');
  assert.ok(st.token && st.token.length >= 32);
  assert.equal(core.authWaiter(st.token).name, 'Ali');
  assert.equal(core.authWaiter('wrong-token-wrong-token-wrong'), null);

  // asking again after approval returns the same token (no duplicate waiter)
  assert.equal(core.requestJoin({ deviceId: 'dev-aaaaaaaaaaaaaaaa', name: 'Ali' }).token, st.token);
  assert.equal(core.getState().waiters.length, 1);

  // reject path
  core.requestJoin({ deviceId: 'dev-bbbbbbbbbbbbbbbb', name: 'Vali' });
  core.rejectJoin(core.getState().joinRequests[0].id);
  assert.equal(core.joinStatus('dev-bbbbbbbbbbbbbbbb').status, 'REJECTED');
  // a rejected device may ask again
  assert.equal(core.requestJoin({ deviceId: 'dev-bbbbbbbbbbbbbbbb', name: 'Vali' }).status, 'PENDING');

  // removal revokes the token and kicks the sockets
  const id = core.getState().waiters[0].id;
  core.removeWaiter(id);
  assert.equal(core.authWaiter(st.token), null);
  assert.deepEqual(kicked, [id]);
  assert.equal(core.joinStatus('dev-aaaaaaaaaaaaaaaa').status, 'REJECTED');
});

test('single click on FREE table offers to one waiter, YES occupies the table', () => {
  const { core, sent } = setup(3);
  const r = press(core, 12, 1);
  assert.equal(r.body.status, 'PENDING');
  const offers = sent.filter((m) => m.event === 'waiter:service_offer');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].payload.tableNumber, 12);

  // the chosen waiter is RESERVED and cannot get another call
  const state = core.getState();
  assert.equal(state.waiters.filter((w) => w.status === 'RESERVED').length, 1);

  assert.deepEqual(answer(core, offers[0], 'YES'), { ok: true });
  const after = core.getState();
  assert.equal(after.tables[0].status, 'OCCUPIED');
  assert.equal(after.tables[0].waiterId, offers[0].waiterId);
  assert.equal(after.waiters.filter((w) => w.status === 'RESERVED').length, 0);
  core.shutdown();
});

test('NO moves to the next waiter and never repeats the same waiter; all NO -> escalated', () => {
  const { core, sent } = setup(3);
  press(core, 5, 1);
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const offer = lastOffer(sent);
    assert.ok(!seen.has(offer.waiterId), 'same waiter offered twice');
    seen.add(offer.waiterId);
    assert.equal(answer(core, offer, 'NO').ok, true);
  }
  const st = core.getState();
  assert.equal(st.escalated.length, 1);
  assert.equal(st.escalated[0].table, 5);
  assert.equal(st.waiters.filter((w) => w.status === 'RESERVED').length, 0);
  core.shutdown();
});

test('timeout forwards to next waiter, then escalates', async () => {
  const { core, sent } = setup(2, 60);
  press(core, 7, 1);
  const first = lastOffer(sent);
  await sleep(110);
  const second = lastOffer(sent);
  assert.notEqual(second.waiterId, first.waiterId);
  assert.ok(sent.some((m) => m.event === 'waiter:service_timeout' && m.waiterId === first.waiterId));
  // the first waiter's late answer is refused
  assert.equal(answer(core, first, 'YES').ok, false);
  await sleep(110);
  assert.equal(core.getState().escalated.length, 1);
  core.shutdown();
});

test('answers are validated: wrong waiter, stale attempt, closed request, bad decision', () => {
  const { core, sent, ids } = setup(2);
  press(core, 1, 1);
  const offer = lastOffer(sent);
  const other = ids.find((i) => i !== offer.waiterId);
  assert.equal(core.handleWaiterResponse(other, {
    requestId: offer.payload.requestId, attemptId: offer.payload.attemptId, kind: 'SERVICE', decision: 'YES',
  }).error, 'not_your_request');
  assert.equal(core.handleWaiterResponse(offer.waiterId, {
    requestId: offer.payload.requestId, attemptId: 'att_fake', kind: 'SERVICE', decision: 'YES',
  }).error, 'stale_attempt');
  assert.equal(core.handleWaiterResponse(offer.waiterId, {
    requestId: offer.payload.requestId, attemptId: offer.payload.attemptId, kind: 'SERVICE', decision: 'MAYBE',
  }).error, 'bad_decision');
  assert.equal(answer(core, offer, 'YES').ok, true);
  assert.equal(answer(core, offer, 'YES').error, 'request_closed'); // double accept
  core.shutdown();
});

test('fairness: every cycle serves each waiter exactly once, in random order', () => {
  const { core, sent } = setup(4);
  const picks = [];
  for (let t = 1; t <= 12; t++) {
    core.adminFreeTable(t); // keep tables free so each press is a fresh service call
    press(core, 100 + t, 1);
    const offer = lastOffer(sent);
    picks.push(offer.waiterId);
    assert.equal(answer(core, offer, 'YES').ok, true);
  }
  for (let c = 0; c < 3; c++) {
    const cycle = picks.slice(c * 4, c * 4 + 4);
    assert.equal(new Set(cycle).size, 4, `cycle ${c} not a permutation: ${cycle}`);
  }
  core.shutdown();
});

test('simultaneous calls for different tables reserve different waiters', () => {
  const { core, sent } = setup(3);
  press(core, 1, 1);
  press(core, 2, 1);
  press(core, 3, 1);
  const offers = sent.filter((m) => m.event === 'waiter:service_offer');
  assert.equal(new Set(offers.map((o) => o.waiterId)).size, 3);
  // fourth call: nobody left -> escalated
  press(core, 4, 1);
  assert.equal(core.getState().escalated.length, 1);
  core.shutdown();
});

test('duplicate event_id does not create a second request; rate limit works', () => {
  const { core, sent } = setup(2);
  const a = core.ingestButtonEvent({ tableNumber: 9, clickType: 1, eventId: 'same-event-id-0001' });
  const b = core.ingestButtonEvent({ tableNumber: 9, clickType: 1, eventId: 'same-event-id-0001' });
  assert.equal(a.body.duplicate, false);
  assert.equal(b.body.duplicate, true);
  assert.equal(sent.filter((m) => m.event === 'waiter:service_offer').length, 1);
  const c = core.ingestButtonEvent({ tableNumber: 9, clickType: 1, eventId: 'another-event-id-02' });
  assert.equal(c.code, 429);
  core.shutdown();
});

test('single click on OCCUPIED table notifies only the assigned waiter', () => {
  const { core, sent, ids } = setup(3);
  press(core, 12, 1);
  const offer = lastOffer(sent);
  answer(core, offer, 'YES');
  sent.length = 0;
  core.handleButtonEvent({ tableNumber: 12, clickType: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'table:assistance_request');
  assert.equal(sent[0].waiterId, offer.waiterId);
  assert.ok(ids.includes(sent[0].waiterId));
  assert.equal(core.getState().tables[0].waiterId, offer.waiterId); // no new assignment
  core.shutdown();
});

test('triple click: FREE ignored; OCCUPIED asks assigned waiter; YES frees, NO keeps', () => {
  const { core, sent } = setup(2);
  assert.equal(press(core, 3, 3).body.status, 'IGNORED_TABLE_FREE');

  press(core, 3, 1);
  const offer = lastOffer(sent);
  answer(core, offer, 'YES');
  sent.length = 0;

  assert.equal(core.handleButtonEvent({ tableNumber: 3, clickType: 3 }).status, 'CHECKOUT_ASKED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'table:checkout_confirmation');
  assert.equal(sent[0].waiterId, offer.waiterId);

  const ask = sent[0];
  assert.equal(answer(core, ask, 'NO', 'CHECKOUT').ok, true);
  assert.equal(core.getState().tables[0].status, 'OCCUPIED');
  assert.equal(core.getState().tables[0].waiterId, offer.waiterId);

  core.handleButtonEvent({ tableNumber: 3, clickType: 3 });
  const ask2 = sent[sent.length - 1];
  assert.equal(answer(core, ask2, 'YES', 'CHECKOUT').ok, true);
  assert.equal(core.getState().tables[0].status, 'FREE');
  assert.equal(core.getState().tables[0].waiterId, null);
  core.shutdown();
});

test('admin can assign an escalated request manually', () => {
  const { core, sent, ids } = setup(1);
  press(core, 8, 1);
  answer(core, lastOffer(sent), 'NO');
  const esc = core.getState().escalated[0];
  assert.ok(esc);
  assert.equal(core.manualAssign({ requestId: esc.id, waiterId: ids[0] }).ok, true);
  const offer = lastOffer(sent);
  assert.equal(offer.payload.requestId, esc.id);
  assert.equal(answer(core, offer, 'YES').ok, true);
  assert.equal(core.getState().tables[0].waiterId, ids[0]);
  assert.equal(core.getState().escalated.length, 0);
  core.shutdown();
});

test('offline waiters are never offered; removing a waiter mid-offer forwards it', () => {
  const { core, sent, ids } = setup(2);
  core.waiterDisconnected(ids[0]); // first waiter goes offline
  press(core, 2, 1);
  assert.equal(lastOffer(sent).waiterId, ids[1]);
  core.waiterConnected(ids[0]);
  core.removeWaiter(ids[1]); // offer holder removed -> goes to the other waiter
  assert.equal(lastOffer(sent).waiterId, ids[0]);
  core.shutdown();
});

test('reconnect sync re-sends only live offers of that waiter', () => {
  const { core, sent } = setup(2);
  press(core, 4, 1);
  const offer = lastOffer(sent);
  const again = core.syncFor(offer.waiterId);
  assert.equal(again.length, 1);
  assert.equal(again[0].payload.requestId, offer.payload.requestId);
  assert.ok(again[0].payload.ttlMs > 0);
  const other = core.getState().waiters.find((w) => w.id !== offer.waiterId).id;
  assert.equal(core.syncFor(other).length, 0);
  core.shutdown();
});
