// Access and refresh tokens for the messaging workspace.
//
// The access token is a short-lived HS256 JWT carrying the account's securityVersion (`sv`), so every existing
// revocation rule in middleware/auth.js keeps working unchanged. The refresh token is a random opaque value stored
// only as a SHA-256 hash; it rotates on every use, and presenting a value that was already rotated means it leaked,
// so the whole family is revoked and `sv` is bumped — which invalidates every access token for that account at once.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { RefreshToken, User } from '../models/index.js';

export const ACCESS_TOKEN_SECONDS = 15 * 60;             // short-lived access token
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;  // 30 days, rotated on every use
export const REFRESH_COOKIE = 'cui_refresh';
// The refresh token is only ever presented to these endpoints, never to the rest of the API.
const REFRESH_COOKIE_PATH = '/api/auth';

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

export const signAccessToken = user => jwt.sign(
  { sub: String(user._id), sv: user.securityVersion },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_SECONDS }
);

/** Reads one cookie without a cookie-parsing dependency (same approach as the SSO router). */
export function readCookie(req, name) {
  for (const part of String(req?.headers?.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return part.slice(index + 1).trim(); }
  }
  return '';
}

// The web client and the API are separate origins (different preview hosts), so the cookie must be SameSite=None —
// which browsers only accept together with Secure. Locally (http://localhost) it stays Lax: same-site, so it is sent.
function cookieSecure(req) {
  const publicOrigin = String(process.env.SSO_ISSUER || process.env.CLIENT_URL || '');
  return /^https:/.test(publicOrigin) || String(req?.headers?.['x-forwarded-proto'] || '') === 'https' || req?.protocol === 'https';
}
const cookieOptions = (req, maxAgeSeconds) => ({
  httpOnly: true, sameSite: cookieSecure(req) ? 'none' : 'lax', secure: cookieSecure(req),
  path: REFRESH_COOKIE_PATH, maxAge: maxAgeSeconds * 1000
});

export const setRefreshCookie = (req, res, token) => res.cookie(REFRESH_COOKIE, token, cookieOptions(req, REFRESH_TOKEN_SECONDS));
export const clearRefreshCookie = (req, res) => res.cookie(REFRESH_COOKIE, '', { ...cookieOptions(req, 0), maxAge: 0 });
export const presentedRefreshToken = req => readCookie(req, REFRESH_COOKIE);

async function storeRefreshToken({ user, familyId, req }) {
  const raw = randomToken();
  await RefreshToken.create({
    user: user._id,
    familyId,
    securityVersion: user.securityVersion,
    tokenHash: sha256(raw),
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 200),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_SECONDS * 1000)
  });
  return raw;
}

const revokeFamily = (familyId, reason) => RefreshToken.updateMany(
  { familyId, revokedAt: null },
  { $set: { revokedAt: new Date(), revokedReason: reason } }
);

/** Starts a session: a fresh access token plus the first refresh token of a new family (one per device). */
export async function startSession(user, req) {
  const familyId = crypto.randomUUID();
  const refreshToken = await storeRefreshToken({ user, familyId, req });
  return { token: signAccessToken(user), refreshToken, expiresIn: ACCESS_TOKEN_SECONDS };
}

/**
 * Rotates the presented refresh token. Returns `{ token, refreshToken, user }`, or `{ error }` where `error` is one of
 * `missing` | `unknown` | `revoked` | `reuse` | `expired` | `account`. A rotated token is single-use: the returned
 * value is the only one that still works, and any later attempt with the previous one revokes the whole family.
 */
export async function rotateSession(rawToken, req) {
  if (!rawToken) return { error: 'missing' };
  const record = await RefreshToken.findOne({ tokenHash: sha256(rawToken) });
  if (!record) return { error: 'unknown' };
  const user = await User.findById(record.user);
  if (record.revokedAt) return { error: 'revoked' };
  if (record.usedAt) {
    await revokeFamily(record.familyId, 'reuse_detected');
    if (user) await User.updateOne({ _id: user._id }, { $inc: { securityVersion: 1 } });
    return { error: 'reuse' };
  }
  if (record.expiresAt <= new Date()) return { error: 'expired' };
  if (!user || user.status !== 'active') { await revokeFamily(record.familyId, 'account_unavailable'); return { error: 'account' }; }
  // A password, role, status or assignment change bumped `sv`: this session must not survive it.
  if (record.securityVersion !== user.securityVersion) { await revokeFamily(record.familyId, 'session_revoked'); return { error: 'revoked' }; }
  const refreshToken = await storeRefreshToken({ user, familyId: record.familyId, req });
  record.usedAt = new Date();
  await record.save();
  return { token: signAccessToken(user), refreshToken, expiresIn: ACCESS_TOKEN_SECONDS, user };
}

/** Ends the session that presented this token (real server-side logout; other devices are untouched). */
export async function endSession(rawToken, reason = 'logout') {
  if (!rawToken) return false;
  const record = await RefreshToken.findOne({ tokenHash: sha256(rawToken) });
  if (!record) return false;
  await revokeFamily(record.familyId, reason);
  return true;
}
