// Integration tests for the messaging workspace's second factor (TOTP), the privileged-role requirement, account
// lockout and the session-management endpoints behind the Security page.
// Run with:  MONGO_URI_TEST=mongodb://127.0.0.1:27017 npm test      (a throw-away database is created and dropped)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { io as ioc } from 'socket.io-client';
import { totpCode } from '../src/services/mfa.js';

const URI = process.env.MONGO_URI_TEST;
const skip = URI ? false : 'MONGO_URI_TEST is not set (integration tests need MongoDB) — NOT RUN';
process.env.JWT_SECRET ||= 'integration_test_secret_0123456789_abcdef_xyz';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.AUTH_RATE_MAX = '2000';   // the suite signs in many throw-away accounts from a single address
delete process.env.SSO_ISSUER;        // the cookie is Secure only for an HTTPS deployment; here it stays Lax

// TOTP steps last 30 seconds. Enrolment deliberately consumes the *previous* step, which leaves the account two usable
// steps inside the server's ±1 window: the current one and the next. A test can therefore complete two sign-ins per
// account, exactly like a person who signs in now and again a minute later.
const STEP_MS = 30_000;
const codeFor = (secret, offsetSteps = 0) => totpCode(secret, Date.now() + offsetSteps * STEP_MS);
const PASSWORD = 'Session@12345';

let base, models, serverMod;
const sockets = [];
const dbName = `cui_mfa_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const newEmail = prefix => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@comsats.edu.pk`;

async function call(path, { method = 'GET', body, token, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null; try { json = await res.json(); } catch { /* empty body */ }
  const setCookies = res.headers.getSetCookie?.() || [];
  return { status: res.status, body: json, cookie: setCookies.map(value => value.split(';')[0]).join('; '), setCookies };
}

const signIn = (email, password = PASSWORD) => call('/api/auth/login', { method: 'POST', body: { email, password } });
const userByEmail = email => models.User.findOne({ email });

/** A Student account created through the public registration route. */
async function student() {
  const email = newEmail('mfa');
  const created = await call('/api/auth/register', { method: 'POST', body: { name: 'MFA Tester', email, password: PASSWORD } });
  assert.equal(created.status, 201, 'registration');
  return { email, password: PASSWORD, token: created.body.token, cookie: created.cookie };
}

/** A privileged account: self-registration only creates Students, so an official is written directly. */
async function privilegedAccount(role = 'Rector', permissions = []) {
  const email = newEmail(role.toLowerCase().replace(/\W+/g, '_'));
  await models.User.create({
    name: `MFA ${role}`, email, passwordHash: await bcrypt.hash(PASSWORD, 4), role, campus: 'Islamabad', department: '',
    assignments: [{ role, scope: 'university', permissions, active: true }]
  });
  const signedIn = await signIn(email);
  assert.equal(signedIn.status, 200, `sign-in for ${role}`);
  return { email, password: PASSWORD, token: signedIn.body.token, cookie: signedIn.cookie };
}

/** Full sign-in for an account whose second factor is on: password first, then the code. */
const signInWithMfa = async (email, secret, offsetSteps = 0) => {
  const challenge = await signIn(email);
  assert.equal(challenge.body.mfaRequired, true, 'the password step alone does not open a session');
  return call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.body.mfaToken, code: codeFor(secret, offsetSteps) } });
};

/** Runs enrolment for a signed-in account; returns the shared secret plus the one-time recovery codes. */
async function enroll(session, offsetSteps = -1) {
  const setup = await call('/api/auth/mfa/setup', { method: 'POST', token: session.token });
  assert.equal(setup.status, 200, 'set-up returns a secret');
  assert.match(String(setup.body.secret || ''), /^[A-Z2-7]{16,}$/, 'a base32 shared secret');
  assert.match(String(setup.body.otpauth || ''), /^otpauth:\/\/totp\//, 'an otpauth URI for the authenticator app');
  assert.match(String(setup.body.qr || ''), /^data:image\/png;base64,/, 'a QR image for the authenticator app');
  const enabled = await call('/api/auth/mfa/enable', { method: 'POST', token: session.token, body: { code: codeFor(setup.body.secret, offsetSteps) } });
  assert.equal(enabled.status, 200, 'enrolment is confirmed by a code');
  assert.equal(enabled.body.recoveryCodes.length, 10, 'ten recovery codes');
  return { secret: setup.body.secret, recoveryCodes: enabled.body.recoveryCodes };
}

const connect = token => new Promise((resolve, reject) => {
  const socket = ioc(base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  socket.on('connect', () => resolve(socket));
  socket.on('connect_error', error => reject(error));
});

before(async () => {
  if (skip) return;
  models = await import('../src/models/index.js');
  serverMod = await import('../src/index.js');
  const port = await serverMod.startServer({ port: 0, mongoUri: `${URI.replace(/\/+$/, '')}/${dbName}` });
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  if (skip) return;
  sockets.forEach(socket => socket.close());
  await new Promise(resolve => setTimeout(resolve, 300));
  await mongoose.connection.dropDatabase().catch(() => {});
  await new Promise(resolve => serverMod.io.close(resolve));
  await mongoose.disconnect();
});

test('enrolment keeps the secret encrypted and hands out ten one-time recovery codes', { skip }, async () => {
  const account = await student();
  const { secret, recoveryCodes } = await enroll(account);
  const user = await userByEmail(account.email).select('+mfa.secret +mfa.recoveryCodes +mfa.pendingSecret');
  assert.equal(user.mfa.enabled, true, 'second factor on');
  assert.match(user.mfa.secret, /^v1\./, 'stored as an AES-256-GCM blob');
  assert.ok(!user.mfa.secret.includes(secret), 'the shared secret is never stored in the clear');
  assert.equal(user.mfa.recoveryCodes.length, 10);
  assert.ok(recoveryCodes.every(code => !user.mfa.recoveryCodes.some(entry => entry.hash === code)), 'recovery codes are stored as hashes only');
  assert.equal(user.mfa.pendingSecret, '', 'the pending secret is cleared');
  // Enrolling strengthens the account, so the session it was done from keeps working.
  assert.equal((await call('/api/auth/me', { token: account.token })).status, 200, 'the current session survives enrolment');
});

test('sign-in becomes two steps, and a code cannot be used twice', { skip }, async () => {
  const account = await student();
  const { secret } = await enroll(account);

  const challenge = await signIn(account.email);
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.mfaRequired, true, 'the password alone does not open a session');
  assert.ok(challenge.body.mfaToken, 'a five-minute second-factor token is returned');
  assert.ok(!challenge.body.token && !challenge.cookie, 'no access token and no refresh cookie yet');
  assert.equal(challenge.body.user, undefined, 'the account profile is not part of the challenge');

  const wrong = await call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.body.mfaToken, code: '000000' } });
  assert.equal(wrong.status, 401, 'a wrong code is refused');

  const verified = await call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.body.mfaToken, code: codeFor(secret) } });
  assert.equal(verified.status, 200, 'the correct code opens the session');
  assert.ok(verified.body.token && verified.cookie, 'access token plus refresh cookie');
  assert.equal(verified.body.user.mfaEnabled, true, 'the session says the factor is on');
  assert.equal((await call('/api/auth/me', { token: verified.body.token })).status, 200);

  const replay = await call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.body.mfaToken, code: codeFor(secret) } });
  assert.equal(replay.status, 401, 'the same code is refused a second time');
  assert.match(replay.body.message, /already used/i, 'and it says why');
});

test('a recovery code signs in once and is then dead', { skip }, async () => {
  const account = await student();
  const { recoveryCodes } = await enroll(account);
  const challenge = await signIn(account.email);
  const first = await call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.body.mfaToken, code: recoveryCodes[0], recovery: true } });
  assert.equal(first.status, 200, 'a recovery code signs the account in');
  assert.ok(first.body.token, 'session issued');
  const second = await call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: (await signIn(account.email)).body.mfaToken, code: recoveryCodes[0], recovery: true } });
  assert.equal(second.status, 401, 'the same recovery code cannot be used twice');
  const stored = await userByEmail(account.email).select('+mfa.recoveryCodes');
  assert.equal(stored.mfa.recoveryCodes.filter(entry => entry.usedAt).length, 1, 'exactly one code is marked used');
});

test('a privileged role cannot reach the messaging API until it enrols a second factor', { skip }, async () => {
  const official = await privilegedAccount('Rector');
  const profile = await call('/api/auth/me', { token: official.token });
  assert.equal(profile.body.user.mfaEnrollmentRequired, true, 'the account is flagged as needing a second factor');

  const refused = await call('/api/conversations', { token: official.token });
  assert.equal(refused.status, 403, 'the messaging API is closed');
  assert.equal(refused.body.code, 'MFA_ENROLLMENT_REQUIRED');
  await assert.rejects(connect(official.token), error => /two-factor/i.test(error.message), 'the socket handshake is refused too');

  await enroll(official);
  const allowed = await call('/api/conversations', { token: official.token });
  assert.equal(allowed.status, 200, 'the API opens once the factor is enrolled');
  assert.equal((await call('/api/auth/me', { token: official.token })).body.user.mfaEnrollmentRequired, false);
  const socket = await connect(official.token);
  assert.equal(socket.connected, true, 'and so does the socket handshake');
});

test('a privileged role cannot switch its second factor off, a student can, and that revokes every session', { skip }, async () => {
  const official = await privilegedAccount('HOD');
  const officialMfa = await enroll(official);
  const officialTry = await call('/api/auth/mfa/disable', { method: 'POST', token: official.token, body: { code: codeFor(officialMfa.secret) } });
  assert.equal(officialTry.status, 403, 'the requirement cannot be removed by the account itself');

  const account = await student();
  const { secret } = await enroll(account);
  const disabled = await call('/api/auth/mfa/disable', { method: 'POST', token: account.token, body: { code: codeFor(secret) } });
  assert.equal(disabled.status, 200, 'a student may turn it off');
  assert.ok(disabled.body.token && disabled.cookie, 'a fresh session replaces the revoked one');
  const user = await userByEmail(account.email);
  assert.equal(user.mfa.enabled, false);
  assert.equal(user.securityVersion, 2, 'removing a factor bumps the security version');
  assert.equal((await call('/api/auth/me', { token: account.token })).status, 401, 'the old access token is dead');
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie })).status, 401, 'the old session family is dead');
  assert.equal((await call('/api/auth/me', { token: disabled.body.token })).status, 200, 'the new session works');
  assert.equal((await signIn(account.email)).body.mfaRequired, undefined, 'sign-in is back to one step');
});

test('the session list marks this device and signs another one out', { skip }, async () => {
  const account = await student();
  const { secret } = await enroll(account);

  const second = await signInWithMfa(account.email, secret, 0);
  assert.equal(second.status, 200);
  const third = await signInWithMfa(account.email, secret, 1);
  assert.equal(third.status, 200, 'a second sign-in uses the next step');

  const list = await call('/api/auth/sessions', { token: third.body.token, cookie: third.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 3, 'registration plus two sign-ins, one entry per device');
  assert.equal(list.body.filter(session => session.current).length, 1, 'exactly one is this device');

  const other = list.body.find(session => !session.current);
  assert.equal((await call(`/api/auth/sessions/${other.id}`, { method: 'DELETE', token: third.body.token })).status, 200);
  const remaining = await call('/api/auth/sessions', { token: third.body.token, cookie: third.cookie });
  assert.equal(remaining.body.length, 2, 'that device is gone from the list');
  assert.equal(remaining.body.some(session => session.id === other.id), false);
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: second.cookie })).status, 401, 'the removed device can no longer renew');
});

test('five wrong codes lock the second-factor step briefly', { skip }, async () => {
  const account = await student();
  const { secret } = await enroll(account);
  const challenge = await signIn(account.email);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const refused = await call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.body.mfaToken, code: '000000' } });
    assert.equal(refused.status, 401, `attempt ${attempt} refused`);
  }
  const user = await userByEmail(account.email);
  assert.ok(user.mfa.lockedUntil > new Date(), 'the step is locked');
  const correct = await call('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.body.mfaToken, code: codeFor(secret) } });
  assert.equal(correct.status, 429, 'even a correct code waits out the lock');
});

test('a Technical Admin can reset a user second factor, and the reset ends that account sessions', { skip }, async () => {
  const target = await student();
  const targetMfa = await enroll(target);
  const liveSession = await signInWithMfa(target.email, targetMfa.secret);
  assert.equal(liveSession.status, 200, 'the target is signed in with a second factor on');
  const targetUser = await userByEmail(target.email);

  const refused = await call(`/api/technical/users/${targetUser._id}/mfa-reset`, { method: 'POST', token: (await student()).token });
  assert.equal(refused.status, 403, 'a Student cannot reset somebody else second factor');

  const admin = await privilegedAccount('Technical Admin', ['system:technical', 'accounts:recover']);
  await enroll(admin);
  const reset = await call(`/api/technical/users/${targetUser._id}/mfa-reset`, { method: 'POST', token: admin.token });
  assert.equal(reset.status, 200);
  const after = await userByEmail(target.email);
  assert.equal(after.mfa.enabled, false, 'the second factor is cleared');
  assert.equal(after.securityVersion, 2, 'and the security version is bumped');
  assert.equal((await call('/api/auth/me', { token: liveSession.body.token })).status, 401, 'the target sessions are dead');
  assert.equal((await call(`/api/technical/users/${targetUser._id}/mfa-reset`, { method: 'POST', token: admin.token })).status, 400, 'resetting twice is refused');
});
