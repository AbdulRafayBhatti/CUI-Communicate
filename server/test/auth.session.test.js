// Integration tests for the access + refresh token layer: real Express server, real MongoDB wire protocol.
// Run with:  MONGO_URI_TEST=mongodb://127.0.0.1:27017 npm test      (a throw-away database is created and dropped)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.MONGO_URI_TEST;
const skip = URI ? false : 'MONGO_URI_TEST is not set (integration tests need MongoDB) — NOT RUN';
process.env.JWT_SECRET ||= 'integration_test_secret_0123456789_abcdef_xyz';
process.env.CLIENT_URL = 'http://localhost:5173';
delete process.env.SSO_ISSUER;   // the cookie is Secure only for an HTTPS deployment; here it stays Lax

let base, models, serverMod;
const dbName = `cui_auth_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const newEmail = () => `session_${Date.now()}_${Math.floor(Math.random() * 1e6)}@comsats.edu.pk`;

// fetch keeps no cookie jar, so the refresh cookie is carried by hand exactly as a browser would.
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
  return {
    status: res.status,
    body: json,
    // "name=value" pairs for the next request, plus the raw attributes for flag assertions.
    cookie: setCookies.map(value => value.split(';')[0]).join('; '),
    setCookies
  };
}

/** Creates a throw-away account and returns its first session (access token + refresh cookie). */
async function newAccount() {
  const email = newEmail();
  const created = await call('/api/auth/register', { method: 'POST', body: { name: 'Session Tester', email, password: 'Session@12345' } });
  assert.equal(created.status, 201, 'registration');
  return { email, ...created };
}

before(async () => {
  if (skip) return;
  models = await import('../src/models/index.js');
  serverMod = await import('../src/index.js');
  const port = await serverMod.startServer({ port: 0, mongoUri: `${URI.replace(/\/+$/, '')}/${dbName}` });
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase().catch(() => {});
  await new Promise(resolve => serverMod.io.close(resolve));
  await mongoose.disconnect();
});

test('sign-in issues a 15-minute access token plus an httpOnly refresh cookie', { skip }, async () => {
  const account = await newAccount();
  assert.ok(account.body.token, 'access token returned');
  assert.equal(account.body.expiresIn, 900, 'access token lifetime is 15 minutes');
  const payload = JSON.parse(Buffer.from(account.body.token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.exp - payload.iat, 900, 'JWT expiry is 15 minutes');
  assert.equal(payload.sv, 1, 'the token still carries the account security version');
  const cookie = account.setCookies.find(value => value.startsWith('cui_refresh='));
  assert.ok(cookie, 'refresh cookie set');
  assert.match(cookie, /HttpOnly/i, 'refresh cookie is not readable from JavaScript');
  assert.match(cookie, /Path=\/api\/auth/i, 'refresh cookie is only sent to the auth endpoints');
  assert.equal((await call('/api/auth/me', { token: account.body.token })).status, 200, 'access token works');
});

test('rotation issues a new pair and the refreshed access token works', { skip }, async () => {
  const account = await newAccount();
  const rotated = await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie });
  assert.equal(rotated.status, 200);
  assert.ok(rotated.body.token, 'a fresh access token is returned');
  assert.ok(rotated.cookie && rotated.cookie !== account.cookie, 'a new refresh cookie');
  assert.equal(rotated.body.user.email, account.email);
  assert.equal((await call('/api/auth/me', { token: rotated.body.token })).status, 200);
});

test('replaying a rotated refresh token revokes the whole family and every access token', { skip }, async () => {
  const account = await newAccount();
  const rotated = await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie });
  assert.equal(rotated.status, 200);

  const replay = await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie });
  assert.equal(replay.status, 401, 'the rotated value is refused');

  const user = await models.User.findOne({ email: account.email });
  assert.equal(user.securityVersion, 2, 'reuse bumps securityVersion so outstanding access tokens die');
  assert.equal((await call('/api/auth/me', { token: account.body.token })).status, 401, 'old access token rejected');
  assert.equal((await call('/api/auth/me', { token: rotated.body.token })).status, 401, 'rotated access token rejected too');
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: rotated.cookie })).status, 401, 'the successor is dead as well');
  assert.equal(await models.RefreshToken.countDocuments({ revokedAt: null, user: user._id }), 0, 'no live token left in the family');
});

test('a later rotation stops working once an earlier token was replayed', { skip }, async () => {
  const account = await newAccount();
  const second = await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie });
  const third = await call('/api/auth/refresh', { method: 'POST', cookie: second.cookie });
  assert.equal(third.status, 200, 'the chain stays healthy while tokens are used once, in order');
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie })).status, 401, 'replay detected');
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: third.cookie })).status, 401, 'the family is revoked');
});

test('logout revokes the session server-side', { skip }, async () => {
  const account = await newAccount();
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: account.cookie })).status, 200);
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie })).status, 401, 'the refresh token no longer works');
  const user = await models.User.findOne({ email: account.email });
  assert.equal(await models.RefreshToken.countDocuments({ revokedAt: null, user: user._id }), 0, 'family revoked');
});

test('a security change ends outstanding refresh sessions', { skip }, async () => {
  const account = await newAccount();
  const user = await models.User.findOne({ email: account.email });
  // The same thing an official's role change or a password change does: bump the account security version.
  await models.User.updateOne({ _id: user._id }, { $inc: { securityVersion: 1 } });
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: account.cookie })).status, 401, 'session must not survive it');
  assert.equal(await models.RefreshToken.countDocuments({ revokedAt: null, user: user._id }), 0, 'family revoked');
});

test('no cookie means no session', { skip }, async () => {
  assert.equal((await call('/api/auth/refresh', { method: 'POST' })).status, 401);
  assert.equal((await call('/api/auth/refresh', { method: 'POST', cookie: 'cui_refresh=not-a-real-token' })).status, 401);
});
