// Centralized authentication service: OAuth 2.0 / OpenID Connect endpoints, the login + MFA + account pages,
// password recovery, and the Google/Facebook flows. Mounted at the server root by src/sso/index.js.
import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  SsoClientApp, SsoSession, SsoSocialState, SsoTenant, SsoUser, SsoPasswordReset
} from './models.js';
import {
  audit, generateRecoveryCodes, generateTotpSecret, hashSecret, otpauthUri, passwordProblems,
  randomToken, safeEqual, sha256, verifySecret, verifyTotp, jwkFromPublicPem, ensureSigningKey
} from './security.js';
import {
  createAuthorizationCode, inspectAccessToken, issueTokenPair, readBearer, redeemAuthorizationCode,
  revokeRefreshToken, revokeSessionTokens, rotateRefreshToken
} from './tokens.js';
import {
  clearSessionCookie, createSession, csrfOk, issuerFrom, loadSession, revokeSession, safeReturnTo, setSessionCookie
} from './session.js';
import * as views from './pages.js';

const router = Router();
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// --- cookies (no extra dependency) and form bodies -------------------------------------------------
router.use((req, res, next) => {
  const header = String(req.headers.cookie || '');
  req.cookies = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    const name = index === -1 ? trimmed : trimmed.slice(0, index);
    const value = index === -1 ? '' : trimmed.slice(index + 1);
    try { req.cookies[decodeURIComponent(name)] = decodeURIComponent(value); } catch { req.cookies[name] = value; }
  }
  next();
});
const formParser = (req, res, next) => {
  if (req.is('application/x-www-form-urlencoded')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100_000) req.destroy(); });
    req.on('end', () => { req.body = Object.fromEntries(new URLSearchParams(body)); next(); });
    return;
  }
  next();
};
router.use(formParser);

const CSRF_COOKIE = 'sso_csrf';
const PRE_AUTH_PAGES = new Set(['/login', '/forgot', '/reset']);
const secureCookie = issuer => String(issuer || '').startsWith('https://');
/** Double-submit CSRF for pages visited before a provider session exists. */
function preAuthCsrf(req, res) {
  let token = req.cookies[CSRF_COOKIE];
  if (!token) {
    token = randomToken(24);
    res.cookie(CSRF_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure: secureCookie(issuerFrom(req)) });
  }
  return token;
}
router.use((req, res, next) => {
  if (req.method !== 'POST' || !PRE_AUTH_PAGES.has(req.path)) return next();
  if (!safeEqual(req.body?._csrf || '', req.cookies[CSRF_COOKIE] || 'x')) {
    return res.status(400).send(views.errorPage({ title: 'Form expired', message: 'Reload the page and try again.' }));
  }
  next();
});

// Only failed sign-ins count towards the throttle, so a shared proxy address never locks people out of
// signing in normally; the per-account lockout below is the precise control.
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true });
const tokenLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const recoveryLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

let signingKeyCache = null;
const signKey = async () => (signingKeyCache ||= await ensureSigningKey());

const activeProviders = tenant => ['google', 'facebook']
  .filter(provider => tenant?.settings?.providers?.[provider]?.enabled)
  .map(provider => ({ provider, label: `Continue with ${provider === 'google' ? 'Google' : 'Facebook'}` }));

const defaultTenant = () => SsoTenant.findOne({ status: 'active' }).sort({ createdAt: 1 });
const clientOf = clientId => SsoClientApp.findOne({ clientId: String(clientId || ''), active: true });

// --- OpenID Connect discovery and keys --------------------------------------------------------------
router.get('/.well-known/openid-configuration', (req, res) => {
  const issuer = issuerFrom(req);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: ['sub', 'email', 'email_verified', 'name', 'role', 'tenant']
  });
});

router.get('/jwks', wrap(async (req, res) => {
  const key = await signKey();
  res.json({ keys: [jwkFromPublicKey(key)] });
}));

function jwkFromPublicKey(key) {
  return jwkFromPublicPem(key.publicPem, key.kid);
}

// --- Authorization endpoint -------------------------------------------------------------------------
router.get('/oauth/authorize', wrap(async (req, res) => {
  const { client_id: clientId, redirect_uri: redirectUri = '', response_type: responseType = 'code', scope = 'openid', state = '', nonce = '', code_challenge: codeChallenge = '', code_challenge_method: codeChallengeMethod = 'S256' } = req.query;

  const client = await clientOf(clientId);
  if (!client) return res.status(400).send(views.errorPage({ title: 'Unknown application', message: 'This client_id is not registered with the SSO provider.' }));

  const tenant = await SsoTenant.findById(client.tenantId);
  if (!tenant || tenant.status !== 'active') return res.status(400).send(views.errorPage({ title: 'Organisation unavailable', message: 'The organisation that owns this application is inactive.' }));

  const redirect = String(redirectUri);
  if (!client.redirectUris.includes(redirect)) {
    return res.status(400).send(views.errorPage({ title: 'Redirect URI not registered', message: 'The requested redirect_uri does not exactly match one registered for this application.' }));
  }
  const fail = (code, description) => {
    const separator = redirect.includes('?') ? '&' : '?';
    return res.redirect(`${redirect}${separator}error=${encodeURIComponent(code)}&error_description=${encodeURIComponent(description)}${state ? `&state=${encodeURIComponent(state)}` : ''}`);
  };
  if (responseType !== 'code') return fail('unsupported_response_type', 'Only the authorization code flow is supported.');
  if (client.type === 'public' && !codeChallenge) return fail('invalid_request', 'PKCE code_challenge is required for public clients.');
  const requestedScopes = String(scope).split(' ').filter(Boolean);
  if (requestedScopes.some(item => !client.scopes.includes(item))) return fail('invalid_scope', 'One or more requested scopes are not registered for this application.');

  const session = await loadSession(req);
  const authorizeUrl = req.originalUrl;
  if (!session) {
    return res.redirect(`/login?client_id=${encodeURIComponent(client.clientId)}&return_to=${encodeURIComponent(authorizeUrl)}`);
  }
  const { user } = session;
  if (String(user.tenantId || '') !== String(tenant._id)) {
    await audit({ tenantId: tenant._id, type: 'authorization.denied', outcome: 'denied', actorId: user._id, actorEmail: user.email, req, detail: `client=${client.clientId} cross-tenant` });
    return res.status(403).send(views.errorPage({ title: 'Different organisation', message: 'You are signed in to another organisation. Sign out and sign in to the account that belongs to this organisation.' }));
  }

  // Per-tenant MFA policy: enrol first when required and missing, otherwise verify in this session.
  const requiresMfa = user.mfa?.enabled || tenant.settings?.mfa === 'required';
  if (requiresMfa && !user.mfa?.enabled) return res.redirect(`/mfa/enroll?return_to=${encodeURIComponent(authorizeUrl)}`);
  if (requiresMfa && !session.session.mfaVerifiedAt) return res.redirect(`/mfa?return_to=${encodeURIComponent(authorizeUrl)}`);

  const code = await createAuthorizationCode({
    user, tenant, client,
    session: session.session,
    redirectUri: redirect,
    scope: requestedScopes.join(' '),
    nonce: String(nonce || ''),
    codeChallenge: String(codeChallenge || ''),
    codeChallengeMethod: String(codeChallengeMethod || 'S256')
  });
  setSessionCookie(res, session.session.sessionId, { maxAgeSeconds: tenant.settings?.sessionLifetimeSeconds || 43200, issuer: issuerFrom(req) });
  const separator = redirect.includes('?') ? '&' : '?';
  return res.redirect(`${redirect}${separator}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`);
}));

// --- Token, userinfo, introspection, revocation ------------------------------------------------------
async function authenticateClient(req) {
  let clientId = req.body?.client_id;
  let secret = req.body?.client_secret;
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Basic ')) {
    const [rawId = '', rawSecret = ''] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    clientId = decodeURIComponent(rawId);
    secret = decodeURIComponent(rawSecret);
  }
  if (!clientId) return { error: 'invalid_client' };
  const client = await SsoClientApp.findOne({ clientId: String(clientId), active: true }).select('+clientSecretHash');
  if (!client) return { error: 'invalid_client' };
  if (client.type === 'confidential' && !await verifySecret(secret, client.clientSecretHash)) return { error: 'invalid_client' };
  return { client };
}

router.post('/oauth/token', tokenLimiter, wrap(async (req, res) => {
  const { client, error } = await authenticateClient(req);
  if (error) {
    await audit({ type: 'token.client_auth_failed', outcome: 'denied', req, detail: String(req.body?.client_id || '') });
    return res.status(401).json({ error: 'invalid_client' });
  }
  const issuer = issuerFrom(req);
  const key = await signKey();
  const grantType = String(req.body?.grant_type || '');

  if (grantType === 'authorization_code') {
    const redeemed = await redeemAuthorizationCode(String(req.body?.code || ''), {
      clientId: client.clientId,
      redirectUri: String(req.body?.redirect_uri || ''),
      codeVerifier: String(req.body?.code_verifier || '')
    });
    if (redeemed.error) {
      await audit({ tenantId: client.tenantId, type: 'token.code_rejected', outcome: 'denied', req, detail: `client=${client.clientId}` });
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const tenant = await SsoTenant.findById(redeemed.code.tenantId);
    const user = await SsoUser.findById(redeemed.code.userId);
    const session = redeemed.code.sessionId ? await SsoSession.findById(redeemed.code.sessionId) : null;
    if (!user || user.status !== 'active' || !tenant || tenant.status !== 'active') return res.status(400).json({ error: 'invalid_grant' });
    const tokens = await issueTokenPair({ user, tenant, client, session, scope: redeemed.code.scope, issuer, key, nonce: redeemed.code.nonce });
    return res.json(tokens);
  }

  if (grantType === 'refresh_token') {
    const tenant = await SsoTenant.findById(client.tenantId);
    const tokens = await rotateRefreshToken({ presented: String(req.body?.refresh_token || ''), client, tenant, issuer, key });
    if (tokens.error) return res.status(400).json({ error: 'invalid_grant' });
    return res.json(tokens);
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
}));

router.get('/oauth/userinfo', wrap(async (req, res) => {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: 'invalid_token' });
  const result = await inspectAccessToken(token, { key: await signKey(), issuer: issuerFrom(req) });
  if (result.error) return res.status(401).json({ error: 'invalid_token' });
  const { claims, user } = result;
  return res.json({
    sub: claims.sub,
    name: user.name,
    email: user.email,
    email_verified: !!user.emailVerified,
    role: user.role,
    tenant: claims.tenant,
    tenant_slug: claims.tenant_slug,
    scope: claims.scope,
    updated_at: Math.floor(new Date(user.updatedAt).getTime() / 1000)
  });
}));

router.post('/oauth/introspect', wrap(async (req, res) => {
  const { client, error } = await authenticateClient(req);
  if (error) return res.status(401).json({ error: 'invalid_client' });
  const result = await inspectAccessToken(String(req.body?.token || ''), { key: await signKey(), issuer: issuerFrom(req) });
  if (result.error) return res.json({ active: false });
  return res.json({ active: true, ...result.claims, username: result.user.email, client_id: client.clientId });
}));

router.post('/oauth/revoke', wrap(async (req, res) => {
  const { client, error } = await authenticateClient(req);
  if (error) return res.status(401).json({ error: 'invalid_client' });
  const token = String(req.body?.token || '');
  await revokeRefreshToken(token, client.clientId);
  await audit({ tenantId: client.tenantId, type: 'token.revoked_by_client', req, detail: `client=${client.clientId}` });
  return res.json({ revoked: true });
}));

// --- Sign-in, second factor, account ----------------------------------------------------------------
router.get('/login', wrap(async (req, res) => {
  const client = req.query.client_id ? await clientOf(req.query.client_id) : null;
  const tenant = client ? await SsoTenant.findById(client.tenantId) : await defaultTenant();
  const csrf = preAuthCsrf(req, res);
  res.send(views.loginPage({
    tenantName: tenant?.name,
    error: String(req.query.error || ''),
    notice: String(req.query.notice || ''),
    hidden: { client_id: client?.clientId || '', return_to: safeReturnTo(req.query.return_to, '/account'), _csrf: csrf },
    showTenantField: !tenant,
    providers: activeProviders(tenant),
    issuer: issuerFrom(req)
  }));
}));

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const returnTo = safeReturnTo(req.body?.return_to, '/account');
  const client = req.body?.client_id ? await clientOf(req.body.client_id) : null;
  const issuer = issuerFrom(req);
  const renderLogin = (error, { tenantName = null, showTenantField = false, providers = [] } = {}) => res.status(401).send(views.loginPage({
    tenantName,
    email,
    error,
    hidden: { client_id: client?.clientId || '', return_to: returnTo, _csrf: preAuthCsrf(req, res) },
    showTenantField,
    providers,
    issuer
  }));

  let tenant = client ? await SsoTenant.findById(client.tenantId) : null;
  if (tenant && tenant.status !== 'active') return renderLogin('That organisation is inactive.');

  let user = null;
  if (tenant) {
    user = await SsoUser.findOne({ tenantId: tenant._id, email }).select('+passwordHash +mfa.secret');
  } else {
    const slug = String(req.body?.tenant || '').trim().toLowerCase();
    const candidates = await SsoUser.find({ email }).select('+passwordHash +mfa.secret');
    if (slug) {
      const scoped = await SsoTenant.findOne({ slug });
      tenant = scoped;
      user = candidates.find(candidate => String(candidate.tenantId || '') === String(scoped?._id || '')) || null;
    } else if (candidates.length === 1) {
      user = candidates[0];
      tenant = user.tenantId ? await SsoTenant.findById(user.tenantId) : null;
    } else if (candidates.length > 1) {
      return renderLogin('This email belongs to more than one organisation. Enter your organisation identifier.');
    }
  }

  const genericFailure = async detail => {
    await audit({ tenantId: tenant?._id, type: 'login.failure', outcome: 'failure', actorEmail: email, req, detail });
    return renderLogin('Email or password is incorrect.', { tenantName: tenant?.name, showTenantField: !tenant, providers: activeProviders(tenant) });
  };
  if (!user) return genericFailure('unknown_account');
  if (user.status !== 'active') {
    await audit({ tenantId: tenant?._id, type: 'login.inactive_account', outcome: 'denied', actorId: user._id, actorEmail: email, req });
    return renderLogin('This account is not active. Contact your administrator.', { tenantName: tenant?.name, providers: activeProviders(tenant) });
  }

  const policy = tenant?.settings || {};
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ tenantId: tenant?._id, type: 'login.locked', outcome: 'denied', actorId: user._id, actorEmail: email, req });
    return renderLogin(`This account is locked after repeated failed sign-ins. Try again after ${user.lockedUntil.toISOString().slice(11, 16)} UTC.`, { tenantName: tenant?.name, providers: activeProviders(tenant) });
  }

  if (!await verifySecret(req.body?.password, user.passwordHash)) {
    // Repeated failed attempts count up and lock the account at the tenant threshold.
    user.failedLogins = (user.failedLogins || 0) + 1;
    if (user.failedLogins >= (policy.maxFailedLogins || 5)) {
      user.failedLogins = 0;
      user.lockedUntil = new Date(Date.now() + (policy.lockoutMinutes || 15) * 60 * 1000);
      await user.save();
      await audit({ tenantId: tenant?._id, type: 'login.lockout', outcome: 'denied', actorId: user._id, actorEmail: email, req });
      return renderLogin(`Too many failed attempts. This account is locked until ${user.lockedUntil.toISOString().slice(11, 16)} UTC.`, { tenantName: tenant?.name, providers: activeProviders(tenant) });
    }
    await user.save();
    return genericFailure('invalid_credentials');
  }

  user.failedLogins = 0;
  user.lockedUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();

  const session = await createSession({ req, user, tenant, mfaVerified: false, authMethods: ['pwd'] });
  setSessionCookie(res, session.sessionId, { maxAgeSeconds: policy.sessionLifetimeSeconds || 43200, issuer });
  await audit({ tenantId: tenant?._id, type: 'login.success', actorId: user._id, actorEmail: email, req, detail: 'password' });

  const requiresMfa = user.mfa?.enabled || policy.mfa === 'required';
  if (requiresMfa && !user.mfa?.enabled) return res.redirect(`/mfa/enroll?return_to=${encodeURIComponent(returnTo)}`);
  if (requiresMfa) return res.redirect(`/mfa?return_to=${encodeURIComponent(returnTo)}`);
  return res.redirect(returnTo);
}));

router.get('/mfa', wrap(async (req, res) => {
  const session = await loadSession(req);
  if (!session) return res.redirect('/login');
  if (!session.user.mfa?.enabled) return res.redirect(`/mfa/enroll?return_to=${encodeURIComponent(safeReturnTo(req.query.return_to, '/account'))}`);
  const attempt = req.query.attempt === 'recovery' ? 'recovery' : 'totp';
  res.send(views.mfaPage({
    attempt,
    returnTo: safeReturnTo(req.query.return_to, '/account'),
    csrf: session.session.csrfToken,
    user: session.user
  }));
}));

router.post('/mfa', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect('/login');
  const { user, session } = loaded;
  const attempt = req.body?.attempt === 'recovery' ? 'recovery' : 'totp';
  const returnTo = safeReturnTo(req.body?.return_to, '/account');
  if (!csrfOk(req, session)) return res.status(400).send(views.errorPage({ title: 'Form expired', message: 'Reload the page and try again.' }));

  let ok = false;
  if (attempt === 'recovery') {
    const withCodes = await SsoUser.findById(user._id).select('+mfa.recoveryCodes');
    for (const entry of withCodes.mfa?.recoveryCodes || []) {
      if (!entry.usedAt && await verifySecret(req.body?.code, entry.hash)) {
        entry.usedAt = new Date();
        ok = true;
        break;
      }
    }
    if (ok) await withCodes.save();
  } else {
    const withSecret = await SsoUser.findById(user._id).select('+mfa.secret');
    ok = verifyTotp(withSecret.mfa?.secret, req.body?.code);
  }

  if (!ok) {
    await audit({ tenantId: session.tenantId, type: 'mfa.failure', outcome: 'failure', actorId: user._id, actorEmail: user.email, req, detail: attempt });
    return res.status(401).send(views.mfaPage({ attempt, returnTo, csrf: session.csrfToken, user, error: 'That code is not valid. Try the next one your app generates.' }));
  }
  session.mfaVerifiedAt = new Date();
  session.authMethods = [...new Set([...(session.authMethods || []), attempt === 'recovery' ? 'recovery_code' : 'totp'])];
  await session.save();
  await audit({ tenantId: session.tenantId, type: 'mfa.success', actorId: user._id, actorEmail: user.email, req, detail: attempt });
  return res.redirect(returnTo);
}));

router.get('/mfa/enroll', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect('/login');
  const { user, session, tenant } = loaded;
  const returnTo = safeReturnTo(req.query.return_to, '/account');
  if (user.mfa?.enabled) return res.redirect(returnTo);
  const secret = generateTotpSecret();
  await SsoUser.updateOne({ _id: user._id }, { $set: { 'mfa.pendingSecret': secret } });
  res.send(views.enrollPage({
    secret,
    otpauth: otpauthUri({ secret, label: user.email, issuer: tenant?.name || 'CUI_Communicate SSO' }),
    returnTo,
    csrf: session.csrfToken,
    user,
    tenantName: tenant?.name
  }));
}));

router.post('/mfa/enroll', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect('/login');
  const { user, session, tenant } = loaded;
  const returnTo = safeReturnTo(req.body?.return_to, '/account');
  if (!csrfOk(req, session)) return res.status(400).send(views.errorPage({ title: 'Form expired', message: 'Reload the page and try again.' }));

  const pending = await SsoUser.findById(user._id).select('+mfa.pendingSecret');
  const secret = pending.mfa?.pendingSecret || '';
  if (!secret || !verifyTotp(secret, req.body?.code)) {
    await audit({ tenantId: tenant?._id, type: 'mfa.enrollment_failed', outcome: 'failure', actorId: user._id, actorEmail: user.email, req });
    return res.status(401).send(views.enrollPage({
      secret, otpauth: otpauthUri({ secret, label: user.email, issuer: tenant?.name || 'CUI_Communicate SSO' }),
      returnTo, csrf: session.csrfToken, user, tenantName: tenant?.name,
      error: 'That code did not match the secret. Check the time on your device and try the next code.'
    }));
  }

  const recoveryCodes = generateRecoveryCodes(10);
  const hashes = await Promise.all(recoveryCodes.map(code => hashSecret(code, 10)));
  await SsoUser.updateOne({ _id: user._id }, {
    $set: {
      'mfa.enabled': true,
      'mfa.secret': secret,
      'mfa.pendingSecret': '',
      'mfa.recoveryCodes': hashes.map(hash => ({ hash })),
      'mfa.enrolledAt': new Date()
    }
  });
  session.mfaVerifiedAt = new Date();
  session.authMethods = [...new Set([...(session.authMethods || []), 'totp'])];
  await session.save();
  await audit({ tenantId: tenant?._id, type: 'mfa.enrolled', actorId: user._id, actorEmail: user.email, req });
  return res.send(views.enrollPage({
    secret,
    otpauth: otpauthUri({ secret, label: user.email, issuer: tenant?.name || 'CUI_Communicate SSO' }),
    recoveryCodes,
    returnTo,
    csrf: session.csrfToken,
    user,
    tenantName: tenant?.name
  }));
}));

router.post('/mfa/disable', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect('/login');
  const { user, session, tenant } = loaded;
  if (!csrfOk(req, session)) return res.status(400).send(views.errorPage({ title: 'Form expired', message: 'Reload the page and try again.' }));
  if (tenant?.settings?.mfa === 'required') {
    return res.status(403).send(views.errorPage({ title: 'Second factor required', message: 'Your organisation requires two-factor authentication, so it cannot be disabled.' }));
  }
  await SsoUser.updateOne({ _id: user._id }, { $set: { 'mfa.enabled': false, 'mfa.secret': '', 'mfa.recoveryCodes': [], 'mfa.pendingSecret': '' } });
  await audit({ tenantId: tenant?._id, type: 'mfa.disabled', actorId: user._id, actorEmail: user.email, req });
  return res.redirect('/account?notice=Two-factor%20authentication%20is%20now%20disabled.');
}));

router.get('/account', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect('/login');
  const { user, session, tenant } = loaded;
  const sessions = await SsoSession.find({ userId: user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  res.send(views.accountPage({
    user,
    tenant,
    sessions,
    csrf: session.csrfToken,
    notice: String(req.query.notice || ''),
    error: String(req.query.error || ''),
    mfaRequired: tenant?.settings?.mfa === 'required',
    providers: activeProviders(tenant)
  }));
}));

router.post('/account/password', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect('/login');
  const { user, session, tenant } = loaded;
  if (!csrfOk(req, session)) return res.status(400).send(views.errorPage({ title: 'Form expired', message: 'Reload the page and try again.' }));
  const withHash = await SsoUser.findById(user._id).select('+passwordHash');
  if (!await verifySecret(req.body?.current, withHash.passwordHash)) {
    await audit({ tenantId: tenant?._id, type: 'password.change_failed', outcome: 'failure', actorId: user._id, actorEmail: user.email, req });
    return res.redirect('/account?error=Your%20current%20password%20is%20incorrect.');
  }
  const problem = passwordProblems(req.body?.next, tenant?.settings?.passwordMinLength || 10);
  if (problem) return res.redirect(`/account?error=${encodeURIComponent(problem)}`);
  withHash.passwordHash = await hashSecret(req.body.next, 12);
  withHash.passwordChangedAt = new Date();
  await withHash.save();
  // Changing a password ends every other session and refresh token for that user.
  await SsoSession.updateMany({ userId: user._id, _id: { $ne: session._id }, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await revokeSessionTokens(session);
  await audit({ tenantId: tenant?._id, type: 'password.changed', actorId: user._id, actorEmail: user.email, req });
  return res.redirect('/account?notice=Password%20updated.%20Other%20sessions%20were%20signed%20out.');
}));

router.post('/account/sessions/revoke', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect('/login');
  const { user, session } = loaded;
  if (!csrfOk(req, session)) return res.status(400).send(views.errorPage({ title: 'Form expired', message: 'Reload the page and try again.' }));
  const target = await SsoSession.findOne({ sessionId: String(req.body?.session || ''), userId: user._id });
  if (target) {
    target.revokedAt = new Date();
    await target.save();
    await revokeSessionTokens(target);
    await audit({ tenantId: session.tenantId, type: 'session.revoked', actorId: user._id, actorEmail: user.email, req });
  }
  const stillCurrent = target && target.sessionId === session.sessionId;
  return res.redirect(stillCurrent ? '/login?notice=Your%20session%20was%20ended.' : '/account?notice=Session%20revoked.');
}));

router.get('/logout', wrap(async (req, res) => {
  const loaded = await loadSession(req);
  if (loaded) {
    await revokeSession(loaded.session);
    await revokeSessionTokens(loaded.session);
    await audit({ tenantId: loaded.session.tenantId, type: 'logout', actorId: loaded.user._id, actorEmail: loaded.user.email, req });
  }
  clearSessionCookie(res, issuerFrom(req));
  const clientId = String(req.query.client_id || '');
  const requested = String(req.query.post_logout_redirect_uri || '');
  const client = clientId ? await clientOf(clientId) : null;
  if (client && requested && client.postLogoutRedirectUris.includes(requested)) return res.redirect(requested);
  return res.redirect('/login?notice=You%20have%20signed%20out.');
}));

// --- Password recovery ------------------------------------------------------------------------------
router.get('/forgot', (req, res) => res.send(views.forgotPage({ csrf: preAuthCsrf(req, res) })));

router.post('/forgot', recoveryLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = await SsoUser.findOne({ email });
  const csrf = preAuthCsrf(req, res);
  const notice = 'If that account exists, a single-use reset link has been issued.';
  if (!user) {
    await audit({ type: 'password.reset_requested', outcome: 'failure', actorEmail: email, req, detail: 'unknown account' });
    return res.send(views.forgotPage({ csrf, notice }));
  }
  const token = randomToken(32);
  await SsoPasswordReset.create({ tokenHash: sha256(token), userId: user._id, tenantId: user.tenantId || null, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
  await audit({ tenantId: user.tenantId, type: 'password.reset_requested', actorId: user._id, actorEmail: email, req });
  const link = `${issuerFrom(req)}/reset?token=${token}`;
  // No mail transport in this development environment: the link is shown in-page instead of emailed.
  return res.send(views.forgotPage({ csrf, notice, resetLink: process.env.SSO_SHOW_RESET_LINKS === 'false' ? '' : link }));
}));

router.get('/reset', (req, res) => res.send(views.resetPage({ csrf: preAuthCsrf(req, res), token: String(req.query.token || '') })));

router.post('/reset', recoveryLimiter, wrap(async (req, res) => {
  const token = String(req.body?.token || '');
  const csrf = preAuthCsrf(req, res);
  const record = await SsoPasswordReset.findOne({ tokenHash: sha256(token) });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return res.status(400).send(views.resetPage({ csrf, token, error: 'This reset link is invalid or has expired. Request a new one.' }));
  }
  if (String(req.body?.password || '') !== String(req.body?.confirm || '')) {
    return res.status(400).send(views.resetPage({ csrf, token, error: 'The two passwords do not match.' }));
  }
  const user = await SsoUser.findById(record.userId);
  const tenant = user?.tenantId ? await SsoTenant.findById(user.tenantId) : null;
  const problem = passwordProblems(req.body?.password, tenant?.settings?.passwordMinLength || 10);
  if (problem) return res.status(400).send(views.resetPage({ csrf, token, error: problem }));

  record.usedAt = new Date();
  await record.save();
  await SsoUser.updateOne({ _id: record.userId }, { $set: { passwordHash: await hashSecret(req.body.password, 12), passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null } });
  await SsoSession.updateMany({ userId: record.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit({ tenantId: record.tenantId, type: 'password.reset_completed', actorId: record.userId, actorEmail: user?.email || '', req });
  return res.redirect('/login?notice=Password%20updated.%20Sign%20in%20with%20your%20new%20password.');
}));

// --- Social sign-in (Google / Facebook) -------------------------------------------------------------
const providerConfig = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    pkce: true
  },
  facebook: {
    label: 'Facebook',
    authorize: 'https://www.facebook.com/v19.0/dialog/oauth',
    token: 'https://graph.facebook.com/v19.0/oauth/access_token',
    userinfo: 'https://graph.facebook.com/me?fields=id,name,email',
    scope: 'email public_profile',
    pkce: false
  }
};
const providerOf = value => (providerConfig[String(value)] ? String(value) : 'google');

async function tenantWithProviderSecret(tenantId, provider) {
  return SsoTenant.findById(tenantId).select(`+settings.providers.${provider}.clientSecret`);
}

router.get('/sso/oauth/:provider/start', wrap(async (req, res) => {
  const provider = providerOf(req.params.provider);
  const config = providerConfig[provider];
  const client = req.query.client_id ? await clientOf(req.query.client_id) : null;
  const baseTenant = client ? await SsoTenant.findById(client.tenantId) : await defaultTenant();
  const tenant = baseTenant ? await tenantWithProviderSecret(baseTenant._id, provider) : null;
  const settings = tenant?.settings?.providers?.[provider];
  if (!tenant || !settings?.enabled || !settings.clientId || !settings.clientSecret) {
    await audit({ tenantId: tenant?._id, type: `social.${provider}_not_configured`, outcome: 'denied', req });
    return res.status(400).send(views.providerNotConfiguredPage({ provider: config.label, tenantName: tenant?.name }));
  }

  const state = randomToken(24);
  const nonce = randomToken(16);
  const codeVerifier = config.pkce ? randomToken(32) : '';
  await SsoSocialState.create({
    state,
    provider,
    tenantId: tenant._id,
    clientId: client?.clientId || '',
    returnTo: safeReturnTo(req.query.return_to, '/account'),
    codeVerifier,
    nonce,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });

  const redirectUri = `${issuerFrom(req)}/sso/oauth/${provider}/callback`;
  const params = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scope,
    state
  });
  if (provider === 'google') {
    params.set('nonce', nonce);
    if (config.pkce) {
      params.set('code_challenge', crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
      params.set('code_challenge_method', 'S256');
    }
  }
  await audit({ tenantId: tenant._id, type: `social.${provider}_redirect`, req, detail: client?.clientId || '' });
  return res.redirect(`${config.authorize}?${params.toString()}`);
}));

router.get('/sso/oauth/:provider/callback', wrap(async (req, res) => {
  const provider = providerOf(req.params.provider);
  const config = providerConfig[provider];
  const issuer = issuerFrom(req);
  if (req.query.error) {
    await audit({ type: `social.${provider}_failure`, outcome: 'failure', req, detail: String(req.query.error_description || req.query.error) });
    return res.status(400).send(views.errorPage({ title: `${config.label} sign-in was cancelled`, message: String(req.query.error_description || req.query.error) }));
  }

  const state = String(req.query.state || '');
  const record = state ? await SsoSocialState.findOne({ state, provider }) : null;
  if (!record || record.expiresAt < new Date()) {
    await audit({ type: `social.${provider}_state_mismatch`, outcome: 'denied', req });
    return res.status(400).send(views.errorPage({ title: 'Sign-in could not be verified', message: 'The state parameter did not match an in-progress sign-in. Start again from the login page.' }));
  }
  await SsoSocialState.deleteOne({ _id: record._id });

  const tenant = await tenantWithProviderSecret(record.tenantId, provider);
  const settings = tenant?.settings?.providers?.[provider];
  if (!tenant || !settings?.clientId || !settings.clientSecret) {
    return res.status(400).send(views.providerNotConfiguredPage({ provider: config.label, tenantName: tenant?.name }));
  }

  let profile = null;
  try {
    const redirectUri = `${issuer}/sso/oauth/${provider}/callback`;
    const body = new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code: String(req.query.code || ''),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    if (record.codeVerifier) body.set('code_verifier', record.codeVerifier);
    const tokenResponse = await fetch(config.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
    const tokenPayload = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error(tokenPayload.error_description || tokenPayload.error || 'token exchange failed');
    const userResponse = await fetch(config.userinfo, { headers: { authorization: `Bearer ${tokenPayload.access_token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    profile = await userResponse.json().catch(() => ({}));
    if (!userResponse.ok) throw new Error('userinfo request failed');
  } catch (error) {
    await audit({ tenantId: tenant._id, type: `social.${provider}_failure`, outcome: 'failure', req, detail: String(error.message || error) });
    return res.status(502).send(views.errorPage({ title: `${config.label} is unavailable`, message: 'The identity provider could not be reached or rejected the exchange. Try again or use your password.' }));
  }

  const providerUserId = String(profile.sub || profile.id || '');
  const email = String(profile.email || '').trim().toLowerCase();
  if (!providerUserId || !email) {
    await audit({ tenantId: tenant._id, type: `social.${provider}_failure`, outcome: 'denied', req, detail: 'no verified email' });
    return res.status(400).send(views.errorPage({ title: 'No verified email returned', message: `${config.label} did not return a verified email address, so the account cannot be linked safely.` }));
  }

  let user = await SsoUser.findOne({ tenantId: tenant._id, email });
  if (user) {
    const existing = (user.socialIdentities || []).find(identity => identity.provider === provider);
    // Prevent unauthorized linking: an account already linked to a different identity of this provider is refused.
    if (existing && existing.providerUserId !== providerUserId) {
      await audit({ tenantId: tenant._id, type: `social.${provider}_link_denied`, outcome: 'denied', actorId: user._id, actorEmail: email, req });
      return res.status(409).send(views.errorPage({ title: 'Account already linked', message: `This account is linked to a different ${config.label} identity. Ask your administrator to unlink it first.` }));
    }
    if (!existing) {
      user.socialIdentities = [...(user.socialIdentities || []), { provider, providerUserId, email, linkedAt: new Date() }];
      await user.save();
      await audit({ tenantId: tenant._id, type: `social.${provider}_linked`, actorId: user._id, actorEmail: email, req });
    }
  } else {
    user = await SsoUser.create({
      tenantId: tenant._id,
      email,
      name: String(profile.name || email).slice(0, 120),
      // Social-only accounts get an unusable random password until they set one through password reset.
      passwordHash: await hashSecret(randomToken(24), 12),
      role: 'member',
      emailVerified: true,
      socialIdentities: [{ provider, providerUserId, email, linkedAt: new Date() }]
    });
    await audit({ tenantId: tenant._id, type: `social.${provider}_account_created`, actorId: user._id, actorEmail: email, req });
  }

  if (user.status !== 'active') return res.status(403).send(views.errorPage({ title: 'Account unavailable', message: 'This account is not active.' }));
  const session = await createSession({ req, user, tenant, mfaVerified: false, authMethods: [provider] });
  setSessionCookie(res, session.sessionId, { maxAgeSeconds: tenant.settings.sessionLifetimeSeconds || 43200, issuer });
  await audit({ tenantId: tenant._id, type: 'login.success', actorId: user._id, actorEmail: email, req, detail: provider });

  const requiresMfa = user.mfa?.enabled || tenant.settings?.mfa === 'required';
  if (requiresMfa && !user.mfa?.enabled) return res.redirect(`/mfa/enroll?return_to=${encodeURIComponent(record.returnTo)}`);
  if (requiresMfa) return res.redirect(`/mfa?return_to=${encodeURIComponent(record.returnTo)}`);
  return res.redirect(record.returnTo);
}));

// --- Landing page -----------------------------------------------------------------------------------
router.get('/', wrap(async (req, res) => {
  const clients = await SsoClientApp.find({ active: true }).sort({ createdAt: 1 });
  res.send(views.docsPage({ issuer: issuerFrom(req), clients }));
}));
router.get('/docs', wrap(async (req, res) => {
  const clients = await SsoClientApp.find({ active: true }).sort({ createdAt: 1 });
  res.send(views.docsPage({ issuer: issuerFrom(req), clients }));
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('SSO request failed:', error.message);
  return res.status(500).send(views.errorPage({ title: 'Something went wrong', message: 'The request could not be completed. Please try again.' }));
});

export default router;
export { authenticateClient, signKey };
