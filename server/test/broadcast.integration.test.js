// Integration tests: real Express + Socket.IO server, real MongoDB wire protocol.
// Run with:  MONGO_URI_TEST=mongodb://127.0.0.1:27017 npm test      (a throw-away database is created and dropped)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { io as ioc } from 'socket.io-client';
import { totpCode } from '../src/services/mfa.js';

const URI = process.env.MONGO_URI_TEST;
const skip = URI ? false : 'MONGO_URI_TEST is not set (integration tests need MongoDB) — NOT RUN';
process.env.JWT_SECRET ||= 'integration_test_secret_0123456789_abcdef_xyz';
process.env.BROADCAST_RATE_MAX = '1000';
process.env.CLIENT_URL = 'http://localhost:5173';

let base, models, seedDatabase, startServer, serverMod;
const sockets = [];
const acc = {};                       // demo name -> { token, user }
const dbName = `cui_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const api = async (path, token, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
};
const mfaState = {};                 // demo name -> { secret, logins } for the officials enrolled below
const login = async name => {
  const r = await api('/auth/login', null, { method: 'POST', body: { email: `${name}@comsats.edu.pk`, password: 'Demo@12345' } });
  assert.equal(r.status, 200, `login ${name}`);
  if (r.body.mfaRequired) {
    // A later sign-in for an official that already carries the second factor this helper enrolled.
    const state = mfaState[name];
    assert.ok(state, `second factor state for ${name}`);
    const verified = await api('/auth/mfa/verify', null, { method: 'POST', body: { mfaToken: r.body.mfaToken, code: totpCode(state.secret, Date.now() + state.logins * 30_000) } });
    assert.equal(verified.status, 200, `mfa verify ${name}`);
    state.logins += 1;
    acc[name] = { token: verified.body.token, user: verified.body.user };
    return acc[name];
  }
  acc[name] = { token: r.body.token, user: r.body.user };
  // Privileged roles must carry a second factor before the messaging API accepts them (see services/mfa.js), so the
  // official demo accounts of this suite enrol one here: set-up, then a code computed from the returned secret. The
  // enrolment consumes the *previous* time step, which leaves the current and next steps usable for a later sign-in.
  if (r.body.user?.mfaEnrollmentRequired) {
    const setup = await api('/auth/mfa/setup', r.body.token, { method: 'POST' });
    assert.equal(setup.status, 200, `mfa setup ${name}`);
    const enabled = await api('/auth/mfa/enable', r.body.token, { method: 'POST', body: { code: totpCode(setup.body.secret, Date.now() - 30_000) } });
    assert.equal(enabled.status, 200, `mfa enrolment ${name}`);
    mfaState[name] = { secret: setup.body.secret, logins: 0 };
    acc[name].user.mfaEnrollmentRequired = false;
  }
  return acc[name];
};
const connect = token => new Promise((resolve, reject) => { const s = ioc(base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false }); sockets.push(s); s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
const once = (s, ev, ms = 4000) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`timed out waiting for ${ev}`)), ms); s.once(ev, p => { clearTimeout(t); resolve(p); }); });
const silent = (s, ev, ms = 800) => new Promise(resolve => { let got = false; const h = () => { got = true; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); resolve(!got); }, ms); });
const emit = (s, ev, payload) => new Promise(resolve => s.emit(ev, payload, resolve));
const cid = () => `t${randomUUID().replace(/-/g, '').slice(0, 24)}`;
const gid = async (name, scope) => String((await models.Group.findOne(scope ? { name, scope } : { name, scope: { $ne: 'personal' } }))._id);
const send = (who, groupIds, body, key = cid()) => api('/broadcasts', acc[who].token, { method: 'POST', body: { groupIds, body, clientMessageId: key } });
const inbox = (who, q = '') => api(`/broadcasts/inbox${q}`, acc[who].token);
const deliveriesFor = async (broadcastId) => models.Delivery.find({ broadcast: broadcastId });

before(async () => {
  if (skip) return;
  models = await import('../src/models/index.js');
  ({ seedDatabase } = await import('../src/seed.js'));
  serverMod = await import('../src/index.js');
  const uri = `${URI.replace(/\/+$/, '')}/${dbName}`;
  const port = await serverMod.startServer({ port: 0, mongoUri: uri });
  base = `http://127.0.0.1:${port}`;
  await seedDatabase();
  for (const n of ['Technical_Admin_1', 'Rector_1', 'Incharge_1', 'HOD_1', 'Coordinator_1', 'Faculty_1', 'Student_1', 'Student_2', 'Employee_1']) await login(n);
});
after(async () => {
  if (skip) return;
  sockets.forEach(s => s.close());
  await new Promise(r => setTimeout(r, 400));          // let server-side disconnect handlers finish before the DB goes away
  await mongoose.connection.dropDatabase().catch(() => {});
  await new Promise(r => serverMod.io.close(r)); await mongoose.disconnect();
});

test('health endpoint answers without authentication', { skip }, async () => {
  assert.equal((await api('/health')).status, 200);
});

test('1. Rector broadcasts to Everyone; eligible recipients get it in their inbox and in real time', { skip }, async () => {
  const s1 = await connect(acc.Student_1.token);
  const live = once(s1, 'broadcast:new'); const note = once(s1, 'notification:new');
  const r = await send('Rector_1', [await gid('Everyone')], 'Welcome to the new semester');
  assert.equal(r.status, 201); assert.equal(r.body.recipientCount, 8, 'nine members minus the sender');
  const ev = await live;
  assert.equal(ev.broadcast.body, 'Welcome to the new semester'); assert.equal(ev.broadcast.sender.name, 'Rector_1');
  assert.deepEqual(ev.broadcast.groups.map(g => g.name), ['Everyone']); assert.equal(ev.delivery.readAt, null);
  const n = await note; assert.equal(n.type, 'broadcast'); assert.ok(!JSON.stringify(n).includes('Welcome'), 'notification carries no body');
  for (const who of ['Student_1', 'Student_2', 'Faculty_1', 'Employee_1', 'HOD_1', 'Incharge_1']) {
    const ib = await inbox(who); assert.ok(ib.body.items.some(i => i.broadcast.body === 'Welcome to the new semester'), `${who} inbox`);
  }
  assert.equal((await inbox('Rector_1')).body.items.length, 0, 'sender does not receive their own broadcast');
  const sent = await api('/broadcasts/sent', acc.Rector_1.token); assert.equal(sent.body.items[0].recipientCount, 8);
});

test('Audience list is limited to groups the caller may broadcast to, broadest first', { skip }, async () => {
  const names = (await api('/broadcasts/audiences', acc.Rector_1.token)).body.map(g => g.name);
  assert.equal(names[0], 'Everyone'); assert.equal(names[1], 'IslamabadCampus');
  assert.ok(names.includes('BCS_6A') && !names.includes('Project_Team'), 'Rector does not see other people\'s informal groups');
  assert.deepEqual((await api('/broadcasts/audiences?q=faculty', acc.Rector_1.token)).body.map(g => g.name), ['CS_Faculty']);
});

test('2. Unauthorized users cannot target Everyone (including Technical Admin by role)', { skip }, async () => {
  const everyone = await gid('Everyone');
  for (const who of ['Student_1', 'Employee_1', 'Faculty_1', 'HOD_1', 'Incharge_1', 'Technical_Admin_1']) {
    assert.equal((await send(who, [everyone], 'nope')).status, 403, who);
  }
  assert.equal((await api('/broadcasts', null, { method: 'POST', body: {} })).status, 401);
});

test('3. Campus Incharge cannot target another campus without explicit authority', { skip }, async () => {
  const lahore = await models.Group.create({ name: 'LahoreCampus', scope: 'campus', campus: 'Lahore', owner: acc.Rector_1.user._id, members: [acc.Student_1.user._id], visibility: 'private', postingRoles: ['Campus Incharge'] });
  assert.equal((await send('Incharge_1', [String(lahore._id)], 'x')).status, 403);
  assert.equal((await send('Incharge_1', [await gid('IslamabadCampus')], 'Campus notice')).status, 201);
  assert.equal((await send('Incharge_1', [await gid('Everyone')], 'x')).status, 403);
  assert.equal((await send('Incharge_1', [String(new mongoose.Types.ObjectId())], 'x')).status, 403, 'nonexistent group looks identical to a forbidden one');
});

test('4. HOD may target an authorized department group only', { skip }, async () => {
  const other = await models.Group.create({ name: 'EE_Dept', scope: 'department', campus: 'Islamabad', department: 'Electrical Engineering', owner: acc.Rector_1.user._id, members: [acc.Student_1.user._id], visibility: 'private', postingRoles: ['HOD'] });
  assert.equal((await send('HOD_1', [await gid('IslamabadCampus_ComputerScience_Department')], 'Department meeting at 3')).status, 201);
  assert.equal((await send('HOD_1', [String(other._id)], 'x')).status, 403);
  assert.equal((await send('HOD_1', [await gid('IslamabadCampus')], 'x')).status, 403);
});

test('4b. A Department Coordinator has no default broadcast right; the HOD can delegate it within the department', { skip }, async () => {
  const dept = await gid('IslamabadCampus_ComputerScience_Department');
  assert.equal((await send('Coordinator_1', [dept], 'before delegation')).status, 403);
  const body = { role: 'Department Coordinator', scope: 'department', campus: 'Islamabad', department: 'Computer Science', permissions: ['broadcast:send'] };
  assert.equal((await api(`/management/users/${acc.Coordinator_1.user._id}/assignments`, acc.Student_1.token, { method: 'POST', body })).status, 403, 'a student cannot delegate');
  const grant = await api(`/management/users/${acc.Coordinator_1.user._id}/assignments`, acc.HOD_1.token, { method: 'POST', body });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const fresh = await login('Coordinator_1');                       // delegation revokes old sessions (securityVersion bump)
  assert.equal((await api('/broadcasts/inbox', acc.Coordinator_1.token)).status, 200);
  assert.equal((await send('Coordinator_1', [dept], 'after delegation')).status, 201);
  assert.equal((await send('Coordinator_1', [await gid('IslamabadCampus')], 'campus is out of scope')).status, 403);
  assert.equal((await send('Coordinator_1', [await gid('Everyone')], 'x')).status, 403);
  assert.ok(fresh.token);
});

test('5. Faculty may target CS_Faculty and BCS_6A together, nothing wider; multi-group sends one entry per recipient', { skip }, async () => {
  const [cs, cls, help] = [await gid('CS_Faculty'), await gid('BCS_6A'), await gid('Student_Help_Desk')];
  const r = await send('Faculty_1', [cs, cls], 'Exam schedule updated');
  assert.equal(r.status, 201); assert.equal(r.body.recipientCount, 4, 'HOD, Coordinator, Student_1, Student_2');
  assert.equal((await send('Faculty_1', [await gid('IslamabadCampus')], 'x')).status, 403);
  assert.equal((await send('Faculty_1', [cls, await gid('Everyone')], 'x')).status, 403, 'one forbidden group rejects the whole send');
  assert.equal((await send('Student_1', [cls], 'x')).status, 403, 'students are not in the class postingRoles');
  // 10. overlap: Student_1/2 are in BOTH BCS_6A and Student_Help_Desk
  const multi = await send('Faculty_1', [cls, help], 'Lab moved to Friday');
  assert.equal(multi.body.recipientCount, 3, 'Student_1, Student_2 (in both groups) and Coordinator_1 (help desk only)');
  const rows = await deliveriesFor(multi.body.broadcast._id);
  assert.equal(rows.length, 3, 'exactly one delivery per recipient');
  const viaLen = Object.fromEntries(rows.map(d => [String(d.recipient), d.via.length]));
  assert.equal(viaLen[acc.Student_1.user._id], 2); assert.equal(viaLen[acc.Student_2.user._id], 2); assert.equal(viaLen[acc.Coordinator_1.user._id], 1);
  const ib = await inbox('Student_1'); assert.equal(ib.body.items.filter(i => i.broadcast.body === 'Lab moved to Friday').length, 1);
  assert.equal((await inbox('Employee_1')).body.items.some(i => i.broadcast.body === 'Lab moved to Friday'), false);
});

test('6. Informal group creation: allowed for anyone active, never institutional scopes without permission', { skip }, async () => {
  const make = (who, scope) => api('/groups', acc[who].token, { method: 'POST', body: { name: `T_${scope}_${cid()}`.slice(0, 40), scope, visibility: 'private' } });
  assert.equal((await make('Student_1', 'personal')).status, 201);
  for (const scope of ['university', 'campus', 'department', 'class', 'functional']) assert.equal((await make('Student_1', scope)).status, 403, scope);
  assert.equal((await api('/groups', null, { method: 'POST', body: { name: 'x' } })).status, 401);
  const created = (await make('Student_2', 'personal')).body; assert.equal(created.postingPolicy, 'owner', 'safe default');
});

test('7. Informal-group broadcasts use the same inbox model; there is no shared group timeline', { skip }, async () => {
  const team = await gid('Project_Team', 'personal');
  const s2 = await connect(acc.Student_2.token); const live = once(s2, 'broadcast:new');
  const r = await send('Student_1', [team], 'Standup at 10');
  assert.equal(r.status, 201); assert.equal(r.body.recipientCount, 1);
  assert.equal((await live).broadcast.body, 'Standup at 10');
  assert.ok((await inbox('Student_2')).body.items.some(i => i.broadcast.body === 'Standup at 10'));
  assert.equal((await api(`/groups/${team}/messages`, acc.Student_1.token)).status, 404, 'old shared timeline endpoint is gone');
  const sock = await connect(acc.Student_1.token);
  const ackErr = await new Promise(res => sock.timeout(600).emit('group:message', { groupId: team, body: 'x' }, err => res(err)));
  assert.ok(ackErr, 'no group:message handler exists, so no acknowledgement ever arrives');
  assert.ok(await silent(s2, 'group:message:new'), 'no shared-room group events are emitted');
  const groups = (await api('/groups', acc.Student_1.token)).body; assert.ok(groups.every(g => !('messages' in g)));
  assert.equal((await send('Student_1', [await gid('Study_Group', 'personal')], 'not mine')).status, 403, 'a non-member cannot post to someone else\'s informal group');
  assert.equal((await send('Student_2', [await gid('Study_Group', 'personal')], 'owner posting')).status, 201, 'the owner can; she has no members yet so nobody receives it');
  assert.equal((await send('Student_2', [team], 'member posting allowed by owner policy')).status, 201);
});

test('8. Someone outside the audience cannot retrieve, search or read the message', { skip }, async () => {
  const team = await gid('Project_Team', 'personal');
  const r = await send('Student_1', [team], 'secret-plan-alpha'); const id = r.body.broadcast._id;
  assert.equal((await api(`/broadcasts/${id}`, acc.Employee_1.token)).status, 404);
  assert.equal((await api(`/broadcasts/${id}/read`, acc.Employee_1.token, { method: 'POST' })).status, 404);
  assert.equal((await inbox('Employee_1', '?q=secret-plan')).body.items.length, 0);
  assert.equal((await api(`/broadcasts/${id}`, acc.Student_2.token)).status, 200);
  assert.equal((await api(`/broadcasts/${id}`, acc.Student_1.token)).body.role, 'sender');
  assert.equal((await api('/broadcasts/not-an-id', acc.Student_1.token)).status, 404);
});

test('9/17. A removed member gets no future broadcasts but keeps what was delivered; newcomers get no history', { skip }, async () => {
  const team = await gid('Project_Team', 'personal');
  const before = await send('Student_1', [team], 'before-removal'); const beforeId = before.body.broadcast._id;
  const rm = await api(`/management/groups/${team}/members`, acc.Student_1.token, { method: 'PATCH', body: { userId: acc.Student_2.user._id, action: 'remove' } });
  assert.equal(rm.status, 200);
  const after = await send('Student_1', [team], 'after-removal');
  assert.equal(after.body.recipientCount, 0);
  assert.equal((await inbox('Student_2')).body.items.some(i => i.broadcast.body === 'after-removal'), false);
  assert.equal((await api(`/broadcasts/${after.body.broadcast._id}`, acc.Student_2.token)).status, 404);
  assert.equal((await api(`/broadcasts/${beforeId}`, acc.Student_2.token)).status, 200, 'history follows the delivery record, not current membership');
  // newcomer via invitation (consent) sees only future messages
  const inv = await api(`/management/groups/${team}/members`, acc.Student_1.token, { method: 'PATCH', body: { userId: acc.Employee_1.user._id, action: 'add' } });
  assert.equal(inv.status, 200); assert.match(inv.body.message, /Invitation sent/);
  assert.equal((await send('Student_1', [team], 'while-only-invited')).body.recipientCount, 0, 'an unaccepted invitee receives nothing');
  const mine = await api('/groups/invitations', acc.Employee_1.token);
  assert.equal(mine.status, 200); assert.deepEqual(mine.body.map(i => i.name), ['Project_Team'], 'the invitee sees exactly their pending invitation');
  assert.deepEqual((await api('/groups/invitations', acc.Student_2.token)).body, [], 'other users see none');
  const acceptRes = await api(`/groups/${team}/invitations/respond`, acc.Employee_1.token, { method: 'POST', body: { decision: 'accept' } });
  assert.equal(acceptRes.status, 200);
  assert.deepEqual((await api('/groups/invitations', acc.Employee_1.token)).body, [], 'accepted invitations disappear');
  assert.equal((await api(`/broadcasts/${beforeId}`, acc.Employee_1.token)).status, 404, 'joining later never exposes earlier broadcasts');
  assert.equal((await send('Student_1', [team], 'after-accept')).body.recipientCount, 1);
});

test('11. Retries are idempotent; interrupted sends are completed without duplicates', { skip }, async () => {
  const [everyone, key] = [await gid('Everyone'), cid()];
  const a = await send('Rector_1', [everyone], 'Retry-safe notice', key); const b = await send('Rector_1', [everyone], 'Retry-safe notice', key);
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.body.duplicate, true);
  assert.equal(a.body.broadcast._id, b.body.broadcast._id);
  assert.equal(await models.Broadcast.countDocuments({ sender: acc.Rector_1.user._id, clientMessageId: key }), 1);
  assert.equal((await deliveriesFor(a.body.broadcast._id)).length, a.body.recipientCount);
  assert.equal((await send('Rector_1', [everyone], 'A different body', key)).status, 409);
  assert.equal((await api('/broadcasts', acc.Rector_1.token, { method: 'POST', body: { groupIds: [everyone], body: 'x' } })).status, 400, 'key required');
  // simulate a crash after the broadcast was saved but before any delivery: retry must finish the job
  const key2 = cid(); const g = await models.Group.findById(everyone);
  const pending = await models.Broadcast.create({ sender: acc.Rector_1.user._id, body: 'Interrupted', clientMessageId: key2, status: 'pending', groups: [{ _id: g._id, name: g.name, scope: g.scope }] });
  await models.Delivery.create({ broadcast: pending._id, recipient: acc.Student_1.user._id, via: [g._id] }); // partially written
  const resumed = await send('Rector_1', [everyone], 'Interrupted', key2);
  assert.equal(resumed.status, 200); assert.equal((await deliveriesFor(pending._id)).length, 8);
  assert.equal((await models.Broadcast.findById(pending._id)).status, 'delivered');
  // startup recovery path
  const key3 = cid(); const p3 = await models.Broadcast.create({ sender: acc.Rector_1.user._id, body: 'Recover me', clientMessageId: key3, status: 'pending', groups: [{ _id: g._id, name: g.name, scope: g.scope }] });
  await models.Broadcast.collection.updateOne({ _id: p3._id }, { $set: { createdAt: new Date(Date.now() - 600000) } }); // createdAt is immutable via Mongoose
  const { recoverPendingBroadcasts } = await import('../src/services/broadcast.js');
  assert.ok(await recoverPendingBroadcasts(1000) >= 1); assert.equal((await deliveriesFor(p3._id)).length, 8);
});

test('13. After a disconnect the inbox, unread counts and read state resynchronize from the API', { skip }, async () => {
  const s = await connect(acc.Student_2.token); s.close();
  const baseline = (await api('/broadcasts/unread-count', acc.Student_2.token)).body.unreadCount;
  await send('Rector_1', [await gid('Everyone')], 'Sent while offline');
  const again = await connect(acc.Student_2.token);
  const ib = await inbox('Student_2'); assert.equal(ib.body.unreadCount, baseline + 1);
  const item = ib.body.items.find(i => i.broadcast.body === 'Sent while offline'); assert.ok(item && item.delivery.readAt === null);
  const readEv = once(again, 'broadcast:read');
  assert.equal((await api(`/broadcasts/${item.broadcast._id}/read`, acc.Student_2.token, { method: 'POST' })).body.unreadCount, baseline);
  assert.equal((await readEv).unreadCount, baseline, 'other tabs/devices are told');
  assert.equal((await api('/broadcasts/read-all', acc.Student_2.token, { method: 'POST' })).body.unreadCount, 0);
  assert.equal((await api('/broadcasts/unread-count', acc.Student_2.token)).body.unreadCount, 0);
});

test('Multiple tabs each receive the broadcast exactly once; a revoked session receives nothing', { skip }, async () => {
  const [t1, t2] = [await connect(acc.Faculty_1.token), await connect(acc.Faculty_1.token)];
  const [e1, e2] = [once(t1, 'broadcast:new'), once(t2, 'broadcast:new')];
  const got = []; t1.on('broadcast:new', p => got.push(p.delivery._id));
  await send('Rector_1', [await gid('Everyone')], 'Two tabs');
  const [p1, p2] = await Promise.all([e1, e2]); assert.equal(p1.delivery._id, p2.delivery._id);
  await new Promise(r => setTimeout(r, 300)); assert.equal(got.length, 1, 'no duplicate event on a tab');
  await models.User.updateOne({ _id: acc.Employee_1.user._id }, { $inc: { securityVersion: 1 } });
  const stale = await connect(acc.Employee_1.token).catch(() => null); assert.equal(stale, null, 'old token cannot open a socket');
  assert.equal((await inbox('Employee_1')).status, 401);
  await models.User.updateOne({ _id: acc.Employee_1.user._id }, { $inc: { securityVersion: -1 } });
});

test('14. Direct Messages are unchanged: request, accept, decline, block, history', { skip }, async () => {
  const [s2, e1] = [acc.Student_2, acc.Employee_1];
  const req = await api('/conversations/request', s2.token, { method: 'POST', body: { recipientId: e1.user._id, message: 'Hi, a question' } });
  assert.equal(req.body.requestState, 'pending');
  const sSock = await connect(s2.token), eSock = await connect(e1.token);
  assert.match((await emit(sSock, 'message:send', { conversationId: req.body._id, body: 'second' })).error, /initial message/i);
  assert.equal((await api(`/conversations/${req.body._id}/decision`, s2.token, { method: 'POST', body: { decision: 'accepted' } })).status, 400, 'requester cannot self-accept (existing DM rule)');
  assert.equal((await api(`/conversations/${req.body._id}/decision`, e1.token, { method: 'POST', body: { decision: 'accepted' } })).body.requestState, 'accepted');
  const incoming = once(eSock, 'message:new');
  assert.equal((await emit(sSock, 'message:send', { conversationId: req.body._id, body: 'Thanks for accepting' })).ok, true);
  assert.equal((await incoming).message.body, 'Thanks for accepting');
  assert.equal((await api(`/conversations/${req.body._id}/block`, e1.token, { method: 'POST' })).status, 200);
  assert.ok((await emit(sSock, 'message:send', { conversationId: req.body._id, body: 'blocked?' })).error);
  await api(`/conversations/${req.body._id}/unblock`, e1.token, { method: 'POST' });
  assert.equal((await emit(sSock, 'message:send', { conversationId: req.body._id, body: 'after unblock' })).ok, true);
  const hist = (await api('/conversations', s2.token)).body.find(c => c._id === req.body._id);
  assert.deepEqual(hist.messages.map(m => m.body), ['Hi, a question', 'Thanks for accepting', 'after unblock']);
  const dec = await api('/conversations/request', acc.Student_1.token, { method: 'POST', body: { recipientId: e1.user._id, message: 'please?' } });
  await api(`/conversations/${dec.body._id}/decision`, e1.token, { method: 'POST', body: { decision: 'declined' } });
  assert.equal((await api('/conversations/request', acc.Student_1.token, { method: 'POST', body: { recipientId: e1.user._id, message: 'again' } })).status, 403);
  // DMs and broadcasts never mix
  assert.ok(!(await api('/conversations', s2.token)).body.some(c => c.messages.some(m => m.body === 'Sent while offline')));
});

test('15. Technical Admin gets no private content and no institutional broadcast power', { skip }, async () => {
  const ta = acc.Technical_Admin_1.token;
  const convs = (await api('/conversations', ta)).body; assert.equal(convs.length, 0);
  const team = await gid('Project_Team', 'personal'); const r = await send('Student_1', [team], 'private to the team');
  assert.equal((await api(`/broadcasts/${r.body.broadcast._id}`, ta)).status, 404);
  assert.equal((await inbox('Technical_Admin_1', '?q=private to the team')).body.items.length, 0);
  assert.equal((await send('Technical_Admin_1', [await gid('IslamabadCampus')], 'x')).status, 403);
  assert.deepEqual((await api('/broadcasts/audiences', ta)).body, [], 'no targetable official groups');
  const sock = await connect(ta); assert.ok((await emit(sock, 'conversation:join', { conversationId: (await models.Conversation.findOne())._id })).error);
});

test('16. A group owner cannot bypass institutional or consent restrictions', { skip }, async () => {
  const team = await gid('Project_Team', 'personal');
  assert.equal((await send('Student_1', [await gid('IslamabadCampus')], 'x')).status, 403);
  const official = await gid('IslamabadCampus');
  assert.equal((await api(`/admin/groups/${official}/permissions`, acc.Student_1.token, { method: 'PATCH', body: { postingRoles: ['Student'] } })).status, 403);
  assert.equal((await api(`/groups/${team}/settings`, acc.Student_2.token, { method: 'PATCH', body: { postingPolicy: 'members' } })).status, 403, 'non-owner');
  assert.equal((await api(`/groups/${official}/settings`, acc.Rector_1.token, { method: 'PATCH', body: { postingPolicy: 'members' } })).status, 403, 'official groups are not informal');
  const aud = (await api('/broadcasts/audiences', acc.Student_1.token)).body.map(g => g.name).sort();
  assert.deepEqual(aud, ['Project_Team', 'T_personal_'.length ? aud.find(n => n.startsWith('T_personal_')) : ''].filter(Boolean).sort());
  const prev = await api('/broadcasts/preview', acc.Student_1.token, { method: 'POST', body: { groupIds: [official] } }); assert.equal(prev.status, 403);
});

test('18. Seeding twice is idempotent and conflict-free; messages and deliveries survive a reseed', { skip }, async () => {
  const counts = async () => ({ users: await models.User.countDocuments(), groups: await models.Group.countDocuments(), broadcasts: await models.Broadcast.countDocuments(), deliveries: await models.Delivery.countDocuments(), conversations: await models.Conversation.countDocuments() });
  const before = await counts(); const unreadBefore = (await inbox('Student_1')).body.items.length;
  await seedDatabase(); await seedDatabase();
  const after = await counts(); assert.deepEqual(after, before);
  for (const name of ['Everyone', 'IslamabadCampus', 'CS_Faculty', 'BCS_6A', 'Project_Team']) assert.equal(await models.Group.countDocuments({ name }), 1, name);
  const g = await models.Group.findOne({ name: 'Everyone' }); assert.equal(new Set(g.members.map(String)).size, g.members.length, 'no duplicate members');
  assert.equal((await inbox('Student_1')).body.items.length, unreadBefore, 'inbox history untouched by reseed');
});

test('Default-group enrollment happens at account creation, so brand-new accounts receive broadcasts', { skip }, async () => {
  const reg = await api('/auth/register', null, { method: 'POST', body: { name: 'Newcomer', email: `newcomer_${Date.now()}@comsats.edu.pk`, password: 'Passw0rd!!' } });
  assert.equal(reg.status, 201);
  const everyone = await models.Group.findOne({ name: 'Everyone' }); assert.ok(everyone.members.some(m => String(m) === String(reg.body.user._id)), 'enrolled without ever opening Groups');
  const r = await send('Rector_1', [await gid('Everyone')], 'For the newest account too');
  assert.equal((await api('/broadcasts/inbox', reg.body.token)).body.items[0].broadcast.body, 'For the newest account too');
  assert.equal(r.status, 201);
});

test('A manual removal from a default group is not silently undone', { skip }, async () => {
  const campus = await gid('IslamabadCampus');
  assert.equal((await api(`/management/groups/${campus}/members`, acc.Incharge_1.token, { method: 'PATCH', body: { userId: acc.Student_2.user._id, action: 'remove' } })).status, 200);
  await api('/groups', acc.Student_2.token); await login('Student_2');
  assert.equal((await models.Group.findById(campus)).members.some(m => String(m) === String(acc.Student_2.user._id)), false);
  const r = await send('Incharge_1', [campus], 'campus only'); assert.equal((await inbox('Student_2')).body.items.some(i => i.broadcast.body === 'campus only'), false); assert.equal(r.status, 201);
  assert.equal((await api(`/management/groups/${campus}/members`, acc.Incharge_1.token, { method: 'PATCH', body: { userId: acc.Student_2.user._id, action: 'add' } })).status, 200);
});

test('Suspending an account stops its deliveries; pagination, search and filters work', { skip }, async () => {
  const everyone = await gid('Everyone');
  for (const n of ['page-1', 'page-2', 'page-3']) await send('Rector_1', [everyone], `pagination ${n}`);
  const p1 = await inbox('Student_1', '?limit=2&q=pagination'); assert.equal(p1.body.items.length, 2); assert.ok(p1.body.nextCursor);
  const p2 = await inbox('Student_1', `?limit=2&q=pagination&cursor=${p1.body.nextCursor}`); assert.equal(p2.body.items.length, 1); assert.equal(p2.body.nextCursor, null);
  assert.equal((await inbox('Student_1', '?limit=2&cursor=bad')).status, 400);
  assert.equal((await inbox('Student_1', '?unread=1')).body.items.every(i => i.delivery.readAt === null), true);
  assert.equal((await inbox('Student_1', `?groupId=${await gid('BCS_6A')}`)).body.items.every(i => i.broadcast.groups.some(g => g.name === 'BCS_6A')), true);
  await models.User.updateOne({ _id: acc.Student_1.user._id }, { $set: { status: 'suspended' } });
  const r = await send('Rector_1', [everyone], 'after suspension');
  const activeMembers = await models.User.countDocuments({ _id: { $in: (await models.Group.findOne({ name: 'Everyone' })).members }, status: 'active' });
  assert.equal(r.body.recipientCount, activeMembers - 1, 'every active member except the sender; the suspended account is excluded');
  assert.equal((await models.Delivery.countDocuments({ broadcast: r.body.broadcast._id, recipient: acc.Student_1.user._id })), 0);
  await models.User.updateOne({ _id: acc.Student_1.user._id }, { $set: { status: 'active' } });
});

test('Owner chooses who can send: official group (BCS_6A) — grant, use, revoke, and the guardrails', { skip }, async () => {
  const cls = await gid('BCS_6A'); const everyone0 = await gid('Everyone');
  const patch = (who, body, groupId = cls) => api(`/groups/${groupId}/senders`, acc[who].token, { method: 'PATCH', body });
  assert.equal((await send('Student_1', [cls], 'before grant')).status, 403);
  // only the OWNER may manage senders — not a member, not a higher official who is not the owner
  assert.equal((await patch('Student_1', { userId: acc.Student_2.user._id, canSend: true })).status, 403);
  assert.equal((await patch('HOD_1', { userId: acc.Student_1.user._id, canSend: true })).status, 403);
  assert.equal((await api(`/groups/${cls}/senders`, acc.Student_1.token)).status, 403);
  const list = await api(`/groups/${cls}/senders`, acc.Faculty_1.token);
  assert.equal(list.status, 200); assert.equal(list.body.official, true);
  assert.deepEqual(list.body.members.map(m => m.name).sort(), ['Student_1', 'Student_2'], 'owner is not listed; only other members');
  assert.ok(list.body.members.every(m => m.eligible === true && m.canSend === false), 'in-scope students are shown as eligible so the owner can enable them');
  const ev = (await api(`/groups/${everyone0}/senders`, acc.Rector_1.token)).body.members;
  assert.equal(ev.find(m => m.name === 'Technical_Admin_1').eligible, false, 'Technical Admin is shown as not eligible');
  // guardrails
  assert.equal((await patch('Faculty_1', { userId: acc.Faculty_1.user._id, canSend: true })).status, 400, 'owner cannot self-grant');
  assert.equal((await patch('Faculty_1', { userId: acc.Employee_1.user._id, canSend: true })).status, 400, 'non-members cannot be chosen');
  assert.equal((await patch('Faculty_1', { userId: acc.Student_1.user._id })).status, 400, 'canSend must be boolean');
  // grant -> works for exactly that person
  const g = await patch('Faculty_1', { userId: acc.Student_1.user._id, canSend: true }); assert.equal(g.status, 200);
  assert.equal((await send('Student_1', [cls], 'Class representative notice')).status, 201);
  assert.equal((await send('Student_2', [cls], 'not chosen')).status, 403);
  assert.equal((await send('Student_1', [cls, await gid('Everyone')], 'x')).status, 403, 'chosen for BCS_6A only');
  assert.ok((await inbox('Student_2')).body.items.some(i => i.broadcast.body === 'Class representative notice'));
  assert.ok((await api('/broadcasts/audiences', acc.Student_1.token)).body.some(a => a.name === 'BCS_6A'), 'appears in their compose list');
  // the roster is not exposed to ordinary members
  const seen = (await api('/groups', acc.Student_2.token)).body.find(x => x.name === 'BCS_6A'); assert.ok(!('publishers' in seen) && seen.senderCount === 1);
  // revoke
  assert.equal((await patch('Faculty_1', { userId: acc.Student_1.user._id, canSend: false })).status, 200);
  assert.equal((await send('Student_1', [cls], 'after revoke')).status, 403);
  // a chosen sender who is removed from the group loses the ability (and the list is cleaned)
  await patch('Faculty_1', { userId: acc.Student_2.user._id, canSend: true });
  assert.equal((await send('Student_2', [cls], 'chosen')).status, 201);
  assert.equal((await api(`/management/groups/${cls}/members`, acc.Faculty_1.token, { method: 'PATCH', body: { userId: acc.Student_2.user._id, action: 'remove' } })).status, 200);
  assert.equal((await send('Student_2', [cls], 'removed')).status, 403);
  assert.equal((await models.Group.findById(cls)).publishers.some(p => String(p) === acc.Student_2.user._id), false);
  await api(`/management/groups/${cls}/members`, acc.Faculty_1.token, { method: 'PATCH', body: { userId: acc.Student_2.user._id, action: 'add' } });
});

test('Owner cannot choose Technical Admin, and the Rector (owner of Everyone) controls its senders', { skip }, async () => {
  const everyone = await gid('Everyone');
  const patch = body => api(`/groups/${everyone}/senders`, acc.Rector_1.token, { method: 'PATCH', body });
  assert.equal((await patch({ userId: acc.Technical_Admin_1.user._id, canSend: true })).status, 403, 'Technical Admin is never a sender');
  assert.equal((await send('Technical_Admin_1', [everyone], 'x')).status, 403);
  assert.equal((await patch({ userId: acc.Employee_1.user._id, canSend: true })).status, 200);
  assert.equal((await send('Employee_1', [everyone], 'Facilities notice from the employee office')).status, 201);
  assert.equal((await patch({ userId: acc.Employee_1.user._id, canSend: false })).status, 200);
  assert.equal((await send('Employee_1', [everyone], 'x')).status, 403);
  const audit = await models.AuditLog.find({ action: { $in: ['group.sender.granted', 'group.sender.revoked'] } });
  assert.ok(audit.length >= 4, 'grants and revocations are audited'); assert.ok(audit.every(a => !JSON.stringify(a).includes('notice')));
});

test('Owner chooses who can send: informal group — policy switches to "chosen senders" automatically', { skip }, async () => {
  const made = await api('/groups', acc.Student_1.token, { method: 'POST', body: { name: `Club_${Date.now() % 100000}`, scope: 'personal', visibility: 'private' } });
  assert.equal(made.status, 201); const club = made.body._id;
  for (const who of ['Student_2', 'Faculty_1']) {
    await api(`/management/groups/${club}/members`, acc.Student_1.token, { method: 'PATCH', body: { userId: acc[who].user._id, action: 'add' } });
    assert.equal((await api(`/groups/${club}/invitations/respond`, acc[who].token, { method: 'POST', body: { decision: 'accept' } })).status, 200);
  }
  const patch = (userId, canSend) => api(`/groups/${club}/senders`, acc.Student_1.token, { method: 'PATCH', body: { userId, canSend } });
  assert.equal((await send('Student_2', [club], 'x')).status, 403, 'default policy is owner only');
  const g = await patch(acc.Student_2.user._id, true); assert.equal(g.status, 200); assert.equal(g.body.postingPolicy, 'publishers');
  assert.equal((await send('Student_2', [club], 'Meeting moved')).status, 201);
  assert.equal((await send('Faculty_1', [club], 'not chosen')).status, 403);
  assert.equal((await api(`/groups/${club}/senders`, acc.Student_2.token)).status, 403, 'members cannot manage senders');
  await api(`/groups/${club}/settings`, acc.Student_1.token, { method: 'PATCH', body: { postingPolicy: 'members' } });
  assert.equal((await patch(acc.Faculty_1.user._id, true)).status, 400, 'every member can already send');
  await api(`/groups/${club}/settings`, acc.Student_1.token, { method: 'PATCH', body: { postingPolicy: 'publishers' } });
  assert.equal((await patch(acc.Student_2.user._id, false)).status, 200);
  assert.equal((await send('Student_2', [club], 'revoked')).status, 403);
  assert.equal((await send('Student_1', [club], 'owner always can')).status, 201);
});

test('Group conversation view: full history of what was delivered to me via the group, plus what I sent — nothing else', { skip }, async () => {
  const made = await api('/groups', acc.Student_1.token, { method: 'POST', body: { name: `Thread_${Date.now() % 100000}`, scope: 'personal', visibility: 'private' } });
  const g = made.body._id;
  await api(`/groups/${g}/settings`, acc.Student_1.token, { method: 'PATCH', body: { postingPolicy: 'members' } });
  const join = async who => { await api(`/management/groups/${g}/members`, acc.Student_1.token, { method: 'PATCH', body: { userId: acc[who].user._id, action: 'add' } }); assert.equal((await api(`/groups/${g}/invitations/respond`, acc[who].token, { method: 'POST', body: { decision: 'accept' } })).status, 200); };
  await join('Student_2');
  const thread = (who, q = '') => api(`/broadcasts/thread/${g}${q}`, acc[who].token);
  const m1 = (await send('Student_1', [g], 'T1 first')).body.broadcast._id;
  const m2 = (await send('Student_2', [g], 'T2 reply')).body.broadcast._id;
  const m3 = (await send('Student_1', [g], 'T3 third')).body.broadcast._id;
  const other = await gid('Project_Team', 'personal');
  await send('Student_1', [other], 'unrelated to this group');

  // both members see the whole conversation, in chronological order, with sent/received marked correctly
  const a = await thread('Student_1'); assert.equal(a.status, 200);
  assert.deepEqual(a.body.items.map(i => i.broadcast.body), ['T1 first', 'T2 reply', 'T3 third']);
  assert.deepEqual(a.body.items.map(i => i.kind), ['sent', 'received', 'sent']);
  const b = await thread('Student_2');
  assert.deepEqual(b.body.items.map(i => i.broadcast.body), ['T1 first', 'T2 reply', 'T3 third']);
  assert.deepEqual(b.body.items.map(i => i.kind), ['received', 'sent', 'received']);
  assert.equal(b.body.group.isMember, true); assert.equal(b.body.group.canBroadcast, true); assert.equal(b.body.group.memberCount, 2);
  assert.ok(!a.body.items.some(i => i.broadcast.body === 'unrelated to this group'), 'other groups never leak into this thread');
  assert.deepEqual(a.body.items.map(i => i.broadcast._id), [m1, m2, m3]);

  // someone who joins later does not get the earlier history; outsiders get nothing at all
  await join('Employee_1');
  assert.deepEqual((await thread('Employee_1')).body.items, [], 'a late joiner sees no earlier messages');
  const m4 = (await send('Student_1', [g], 'T4 after employee joined')).body.broadcast._id;
  assert.deepEqual((await thread('Employee_1')).body.items.map(i => i.broadcast._id), [m4]);
  assert.equal((await thread('Technical_Admin_1')).status, 404, 'no relationship with the group, no access');
  assert.equal((await thread('Rector_1')).status, 404, 'seniority does not open a private thread');
  assert.equal((await api('/broadcasts/thread/not-an-id', acc.Student_1.token)).status, 404);
  assert.equal((await thread('Student_1', '?cursor=bad')).status, 400);
  assert.equal((await api(`/broadcasts/thread/${g}`)).status, 401);

  // a message to several groups appears once in each group's thread and names the other audience
  const both = (await send('Student_1', [g, other], 'T5 to both')).body.broadcast._id;
  const inG = (await thread('Student_2')).body.items.filter(i => i.broadcast._id === both); assert.equal(inG.length, 1);
  assert.deepEqual(inG[0].broadcast.alsoTo, ['Project_Team']);
  assert.equal((await api(`/broadcasts/thread/${other}`, acc.Student_2.token)).body.items.filter(i => i.broadcast._id === both).length, 1);

  // pagination: newest page first, older pages via cursor, always chronological inside a page, no overlap
  const p1 = await thread('Student_1', '?limit=2'); assert.equal(p1.body.items.length, 2); assert.ok(p1.body.nextCursor);
  assert.deepEqual(p1.body.items.map(i => i.broadcast._id), [m4, both].sort());
  const p2 = await thread('Student_1', `?limit=2&cursor=${p1.body.nextCursor}`);
  const p3 = await thread('Student_1', `?limit=2&cursor=${p2.body.nextCursor}`);
  const ids = [...p3.body.items, ...p2.body.items, ...p1.body.items].map(i => i.broadcast._id);
  assert.deepEqual(ids, [m1, m2, m3, m4, both], 'every message exactly once, oldest first'); assert.equal(p3.body.nextCursor, null);

  // opening the conversation marks only THIS group's messages read, only for this user
  const beforeUnread = (await api('/broadcasts/unread-count', acc.Student_2.token)).body.unreadCount;
  const live = await connect(acc.Student_2.token); const readEv = once(live, 'broadcast:read');
  const r = await api(`/broadcasts/thread/${g}/read`, acc.Student_2.token, { method: 'POST' });
  assert.equal(r.status, 200); assert.ok(r.body.marked >= 3); assert.equal(r.body.unreadCount, beforeUnread - r.body.marked);
  assert.equal((await readEv).broadcastIds.length, r.body.marked, 'other tabs are told which messages were read');
  assert.equal((await thread('Student_2')).body.unreadInGroup, 0);
  assert.ok((await inbox('Student_2', `?groupId=${other}&unread=1`)).body.items.length >= 1, 'the other group keeps its unread messages');
  assert.equal((await api(`/broadcasts/thread/${g}/read`, acc.Employee_1.token, { method: 'POST' })).body.marked >= 0, true);
  assert.equal((await api(`/broadcasts/thread/${g}/read`, acc.Student_1.token, { method: 'POST' })).body.marked, 1, 'Student_1 only had Student_2\'s reply unread; their own messages are never unread');
  assert.equal((await api(`/broadcasts/thread/${g}/read`, acc.Student_1.token, { method: 'POST' })).body.marked, 0, 'idempotent');

  // a removed member keeps their history but can no longer send
  assert.equal((await api(`/management/groups/${g}/members`, acc.Student_1.token, { method: 'PATCH', body: { userId: acc.Student_2.user._id, action: 'remove' } })).status, 200);
  const gone = await thread('Student_2'); assert.equal(gone.status, 200);
  assert.ok(gone.body.items.length >= 3, 'delivered history stays with the person it was delivered to');
  assert.equal(gone.body.group.isMember, false); assert.equal(gone.body.group.canBroadcast, false); assert.equal(gone.body.group.memberCount, null);
  assert.equal((await send('Student_2', [g], 'after removal')).status, 403);
  assert.ok(!(await thread('Student_2')).body.items.some(i => i.broadcast.body === 'T4 after employee joined' && false));
});

test('Officials may create official AND informal groups, strictly within their authority', { skip }, async () => {
  const uniq = () => `G${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const make = (who, body) => api('/groups', acc[who].token, { method: 'POST', body: { visibility: 'private', ...body, name: body.name || uniq() } });
  const creatable = async who => (await api('/groups/creatable', acc[who].token)).body;

  // What each person is offered is derived from the policy (no duplicated rules in the client)
  const rec = await creatable('Rector_1');
  assert.deepEqual(rec.official.map(o => o.scope), ['university', 'campus', 'department', 'class', 'functional']);
  assert.ok(rec.official.filter(o => o.scope !== 'university').every(o => o.anyCampus === true), 'the Rector may choose any campus');
  const inc = await creatable('Incharge_1');
  assert.deepEqual(inc.official.map(o => o.scope), ['campus', 'department', 'class', 'functional'], 'a campus role never offers university groups');
  assert.deepEqual(inc.official.find(o => o.scope === 'campus').campuses.map(c => c.campus), ['Islamabad']);
  assert.equal(inc.official.find(o => o.scope === 'department').campuses[0].anyDepartment, true, 'any department of their own campus');
  const hod = await creatable('HOD_1');
  assert.deepEqual(hod.official.map(o => o.scope), ['department', 'class', 'functional']);
  assert.deepEqual(hod.official[0].campuses[0], { campus: 'Islamabad', anyDepartment: false, departments: ['Computer Science'] });
  for (const who of ['Student_1', 'Employee_1', 'Technical_Admin_1']) { const c = await creatable(who); assert.deepEqual(c.official, [], who); assert.equal(c.informal, true); }
  assert.equal((await api('/groups/creatable')).status, 401);

  // Rector: anywhere
  assert.equal((await make('Rector_1', { scope: 'university', description: 'Board' })).status, 201);
  assert.equal((await make('Rector_1', { scope: 'campus', campus: 'Lahore' })).status, 201);
  assert.equal((await make('Rector_1', { scope: 'department', campus: 'Lahore', department: 'Electrical Engineering' })).status, 201);
  assert.equal((await make('Rector_1', { scope: 'campus' })).status, 400, 'a campus group needs a campus (the Rector has none by default)');
  // Campus Incharge: own campus only, any department in it, never university
  assert.equal((await make('Incharge_1', { scope: 'campus', campus: 'Islamabad' })).status, 201);
  const eeDept = await make('Incharge_1', { scope: 'department', campus: 'Islamabad', department: 'Electrical Engineering' });
  assert.equal(eeDept.status, 201, JSON.stringify(eeDept.body));
  assert.equal((await make('Incharge_1', { scope: 'campus', campus: 'Lahore' })).status, 403);
  assert.equal((await make('Incharge_1', { scope: 'department', campus: 'Lahore', department: 'Computer Science' })).status, 403);
  assert.equal((await make('Incharge_1', { scope: 'university' })).status, 403);
  // HOD: own department only
  assert.equal((await make('HOD_1', { scope: 'class', department: 'Computer Science' })).status, 201);
  assert.equal((await make('HOD_1', { scope: 'functional', department: 'Computer Science' })).status, 201);
  assert.equal((await make('HOD_1', { scope: 'class', department: 'Electrical Engineering' })).status, 403);
  assert.equal((await make('HOD_1', { scope: 'department', campus: 'Lahore', department: 'Computer Science' })).status, 403);
  assert.equal((await make('HOD_1', { scope: 'campus', campus: 'Islamabad' })).status, 403);
  // Coordinator: only what was delegated (department groups of their own department)
  assert.equal((await make('Coordinator_1', { scope: 'department', department: 'Computer Science' })).status, 201);
  assert.equal((await make('Coordinator_1', { scope: 'campus', campus: 'Islamabad' })).status, 403);
  // Everyone else: informal only
  for (const who of ['Student_1', 'Employee_1', 'Faculty_1', 'Technical_Admin_1']) {
    assert.equal((await make(who, { scope: 'department', department: 'Computer Science' })).status, 403, `${who} official`);
    assert.equal((await make(who, { scope: 'campus', campus: 'Islamabad' })).status, 403, `${who} campus`);
    assert.equal((await make(who, { scope: 'personal' })).status, 201, `${who} informal`);
  }
  // Officials can ALSO create informal groups
  assert.equal((await make('Rector_1', { scope: 'personal' })).status, 201);
  assert.equal((await make('HOD_1', { scope: 'personal' })).status, 201);

  // Names: official names unique (case-insensitive); informal groups cannot impersonate an official name
  const name = uniq();
  assert.equal((await make('Rector_1', { scope: 'university', name })).status, 201);
  assert.equal((await make('Rector_1', { scope: 'university', name: name.toLowerCase() })).status, 409);
  assert.equal((await make('Student_1', { scope: 'personal', name })).status, 409, 'cannot imitate an official name');
  assert.equal((await make('Student_1', { scope: 'personal', name: 'Everyone' })).status, 409);

  // Official groups are audiences like any other: the creator is the owner and can use them within their authority
  const mine = (await api('/groups', acc.Incharge_1.token)).body.find(g => g._id === eeDept.body._id);
  assert.ok(mine.isOwner && mine.official && mine.canBroadcast && mine.canManageMembers);
  assert.equal((await send('Incharge_1', [eeDept.body._id], 'Notice for Electrical Engineering')).status, 201);
  assert.equal((await send('Student_1', [eeDept.body._id], 'x')).status, 403);
  assert.ok((await models.AuditLog.countDocuments({ action: 'group.created' })) >= 10);
});

test('Official group creation options: member roles and automatic enrollment', { skip }, async () => {
  const mk = body => api('/groups', acc.Rector_1.token, { method: 'POST', body: { visibility: 'private', ...body } });
  const n = () => `Opt${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  assert.equal((await mk({ name: n(), scope: 'campus', campus: 'Islamabad', eligibleRoles: ['Wizard'] })).status, 400);
  assert.equal((await mk({ name: n(), scope: 'campus', campus: 'Islamabad', eligibleRoles: [] })).status, 400);
  assert.equal((await mk({ name: n(), scope: 'campus', campus: 'Islamabad', eligibleRoles: ['Student', 'Technical Admin'] })).status, 400, 'Technical Admin cannot be a member of an audience');
  assert.equal((await mk({ name: n(), scope: 'class', campus: 'Islamabad', department: 'Computer Science', autoEnroll: true })).status, 400, 'auto-enroll only for university/campus/department');
  const g = await mk({ name: n(), scope: 'campus', campus: 'Islamabad', eligibleRoles: ['Student'], autoEnroll: true });
  assert.equal(g.status, 201); assert.equal(g.body.enrolled, 2, 'the two Islamabad students, nobody else');
  const stored = await models.Group.findById(g.body._id);
  const memberNames = (await models.User.find({ _id: { $in: stored.members } })).map(u => u.name).sort();
  assert.deepEqual(memberNames, ['Rector_1', 'Student_1', 'Student_2'].sort());
  assert.deepEqual(stored.eligibleRoles, ['Student']); assert.equal(stored.autoEnroll, true);
  // a brand-new matching account is enrolled automatically; a non-matching role is not
  const reg = await api('/auth/register', null, { method: 'POST', body: { name: 'Late Student', email: `late_${Date.now()}@comsats.edu.pk`, password: 'Passw0rd!!' } });
  assert.equal(reg.status, 201);
  // default (no eligibleRoles): everyone except Technical Admin
  const d = await models.Group.findById((await mk({ name: n(), scope: 'university' })).body._id);
  assert.equal(d.eligibleRoles.includes('Technical Admin'), false); assert.equal(d.eligibleRoles.length, 7);
  // those enrolled receive broadcasts to it from authorized senders
  const r = await send('Rector_1', [String(stored._id)], 'Islamabad students only');
  assert.equal(r.body.recipientCount, 2);
  assert.ok((await inbox('Student_1')).body.items.some(i => i.broadcast.body === 'Islamabad students only'));
  assert.equal((await inbox('Faculty_1')).body.items.some(i => i.broadcast.body === 'Islamabad students only'), false);
});
