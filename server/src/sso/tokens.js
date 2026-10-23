// Access/id token issuing (RS256), refresh-token rotation with family-wide revocation on replay,
// and authorization-code redemption.
import jwt from 'jsonwebtoken';
import { SsoAuthorizationCode, SsoClientApp, SsoRefreshToken, SsoSession, SsoUser } from './models.js';
import { audit, randomToken, sha256, verifyPkce } from './security.js';

export const AUTH_CODE_TTL_MS = 60_000;
export const MIN_ACCESS_SECONDS = 300;

export const readBearer = req => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

export async function createAuthorizationCode({ user, tenant, client, session, redirectUri, scope, nonce, codeChallenge, codeChallengeMethod }) {
  const code = randomToken(32);
  await SsoAuthorizationCode.create({
    codeHash: sha256(code),
    tenantId: tenant._id,
    userId: user._id,
    clientId: client.clientId,
    redirectUri,
    scope,
    nonce: nonce || '',
    codeChallenge: codeChallenge || '',
    codeChallengeMethod: codeChallengeMethod || '',
    sessionId: session?._id,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS)
  });
  await audit({ tenantId: tenant._id, type: 'authorization.code_issued', actorId: user._id, actorEmail: user.email, detail: `client=${client.clientId}` });
  return code;
}

/** Single-use code redemption; validates client, exact redirect URI and the PKCE verifier. */
export async function redeemAuthorizationCode(code, { clientId, redirectUri, codeVerifier }) {
  const doc = await SsoAuthorizationCode.findOne({ codeHash: sha256(code) });
  if (!doc || doc.usedAt || doc.expiresAt < new Date()) return { error: 'invalid_grant' };
  if (doc.clientId !== clientId || doc.redirectUri !== redirectUri) return { error: 'invalid_grant' };
  if (!verifyPkce(codeVerifier, doc.codeChallenge, doc.codeChallengeMethod || 'S256')) return { error: 'invalid_grant' };
  doc.usedAt = new Date();
  await doc.save();
  return { code: doc };
}

function claimsFor({ user, tenant, client, session, issuer, scope, now }) {
  return {
    iss: issuer,
    sub: String(user._id),
    aud: client.clientId,
    tenant: String(tenant?._id || ''),
    tenant_slug: tenant?.slug || '',
    email: user.email,
    name: user.name,
    role: user.role,
    scope,
    sid: session?.sessionId || '',
    iat: now,
    jti: randomToken(12)
  };
}

/**
 * Issues a short-lived signed access token, an id_token (when the openid scope is present) and a rotating
 * refresh token. Lifetimes come from the tenant policy, which the schema clamps to safe limits.
 */
export async function issueTokenPair({ user, tenant, client, session, scope, issuer, key, nonce }) {
  const now = Math.floor(Date.now() / 1000);
  const accessSeconds = tenant?.settings?.accessTokenSeconds || 900;
  const refreshSeconds = tenant?.settings?.refreshTokenSeconds || 1209600;
  const base = claimsFor({ user, tenant, client, session, issuer, scope, now });
  const amr = session?.authMethods?.length ? session.authMethods : ['pwd'];

  const access_token = jwt.sign({ ...base, amr, exp: now + accessSeconds }, key.privatePem, { algorithm: 'RS256', keyid: key.kid });
  const refresh_token = randomToken(32);
  const family = randomToken(16);
  await SsoRefreshToken.create({
    tokenHash: sha256(refresh_token),
    tenantId: tenant?._id || null,
    userId: user._id,
    clientId: client.clientId,
    family,
    scope,
    sessionId: session?._id,
    expiresAt: new Date(Date.now() + refreshSeconds * 1000)
  });

  const response = { access_token, token_type: 'Bearer', expires_in: accessSeconds, refresh_token, scope };
  if (String(scope || '').split(' ').includes('openid')) {
    response.id_token = jwt.sign({
      iss: issuer,
      sub: String(user._id),
      aud: client.clientId,
      tenant: String(tenant?._id || ''),
      email: user.email,
      email_verified: !!user.emailVerified,
      name: user.name,
      role: user.role,
      amr,
      auth_time: session?.createdAt ? Math.floor(new Date(session.createdAt).getTime() / 1000) : now,
      ...(nonce ? { nonce } : {}),
      iat: now,
      exp: now + accessSeconds
    }, key.privatePem, { algorithm: 'RS256', keyid: key.kid });
  }
  await audit({ tenantId: tenant?._id, type: 'token.issued', actorId: user._id, actorEmail: user.email, detail: `client=${client.clientId} scope=${scope}` });
  return response;
}

/** Refresh-token rotation. Presenting an already-used token revokes every token in that family. */
export async function rotateRefreshToken({ presented, client, tenant, issuer, key }) {
  const doc = await SsoRefreshToken.findOne({ tokenHash: sha256(presented) });
  if (!doc || doc.clientId !== client.clientId) return { error: 'invalid_grant' };
  if (doc.revokedAt || doc.usedAt) {
    await SsoRefreshToken.updateMany({ family: doc.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit({ tenantId: doc.tenantId, type: 'token.reuse_detected', outcome: 'denied', detail: `family=${doc.family} client=${doc.clientId}` });
    return { error: 'invalid_grant' };
  }
  if (doc.expiresAt < new Date()) return { error: 'invalid_grant' };
  const user = await SsoUser.findById(doc.userId);
  if (!user || user.status !== 'active') return { error: 'invalid_grant' };
  const session = doc.sessionId ? await SsoSession.findById(doc.sessionId) : null;
  if (session && (session.revokedAt || session.expiresAt < new Date())) return { error: 'invalid_grant' };

  doc.usedAt = new Date();
  await doc.save();
  const pair = await issueTokenPair({ user, tenant, client, session, scope: doc.scope, issuer, key });
  const rotated = await SsoRefreshToken.findOne({ tokenHash: sha256(pair.refresh_token) });
  if (rotated) {
    rotated.family = doc.family;
    await rotated.save();
  }
  doc.replacedBy = sha256(pair.refresh_token);
  await doc.save();
  await audit({ tenantId: doc.tenantId, type: 'token.refreshed', actorId: user._id, actorEmail: user.email, detail: `client=${client.clientId}` });
  return pair;
}

export async function revokeRefreshToken(presented, clientId) {
  const doc = await SsoRefreshToken.findOne({ tokenHash: sha256(presented) });
  if (!doc || (clientId && doc.clientId !== clientId)) return false;
  await SsoRefreshToken.updateMany({ family: doc.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit({ tenantId: doc.tenantId, type: 'token.revoked', detail: `client=${doc.clientId}` });
  return true;
}

export async function revokeSessionTokens(session) {
  if (!session) return;
  await SsoRefreshToken.updateMany({ sessionId: session._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/** Validates signature, issuer and expiry, then loads the token's subject and client. */
export async function inspectAccessToken(token, { key, issuer }) {
  let claims;
  try {
    claims = jwt.verify(token, key.publicPem, { algorithms: ['RS256'], issuer, audience: undefined });
  } catch (error) {
    return { error: error.name === 'TokenExpiredError' ? 'expired' : 'invalid_token' };
  }
  const client = await SsoClientApp.findOne({ clientId: claims.aud, active: true });
  if (!client) return { error: 'invalid_token' };
  const user = await SsoUser.findById(claims.sub);
  if (!user || user.status !== 'active') return { error: 'invalid_token' };
  if (String(user.tenantId || '') !== String(claims.tenant || '')) return { error: 'invalid_token' };
  const session = claims.sid ? await SsoSession.findOne({ sessionId: claims.sid }) : null;
  if (claims.sid && (!session || session.revokedAt || session.expiresAt < new Date())) return { error: 'invalid_token' };
  return { claims, user, client, session };
}
