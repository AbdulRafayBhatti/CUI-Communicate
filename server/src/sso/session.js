// Provider-side browser session: the single sign-on cookie, CSRF protection and helpers shared by the
// OIDC routes and the admin dashboard.
import { SsoSession, SsoTenant, SsoUser } from './models.js';
import { randomToken, safeEqual } from './security.js';

export const SESSION_COOKIE = 'cui_sso_session';

export const issuerFrom = req => {
  if (process.env.SSO_ISSUER) return String(process.env.SSO_ISSUER).replace(/\/$/, '');
  const host = req?.headers?.host || `localhost:${process.env.PORT || 5000}`;
  return `${req?.protocol || 'http'}://${host}`;
};

export const cookieOptions = ({ maxAgeSeconds, issuer }) => ({
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: String(issuer || '').startsWith('https://'),
  maxAge: maxAgeSeconds * 1000
});

export function setSessionCookie(res, sessionId, { maxAgeSeconds, issuer }) {
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions({ maxAgeSeconds, issuer }));
}

export const clearSessionCookie = (res, issuer) => res.clearCookie(SESSION_COOKIE, { path: '/', secure: String(issuer || '').startsWith('https://') });

/** Only same-site relative paths may be used as a post-login destination (no open redirects). */
export function safeReturnTo(value, fallback = '/account') {
  const candidate = String(value || '');
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  return fallback;
}

export async function createSession({ req, user, tenant, mfaVerified = false, authMethods = ['pwd'] }) {
  const settings = tenant?.settings || {};
  const lifetime = settings.sessionLifetimeSeconds || 43200;
  const session = await SsoSession.create({
    sessionId: randomToken(32),
    tenantId: tenant?._id || null,
    userId: user._id,
    csrfToken: randomToken(24),
    mfaVerifiedAt: mfaVerified ? new Date() : null,
    authMethods,
    ip: req.ip || '',
    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 300),
    expiresAt: new Date(Date.now() + lifetime * 1000)
  });
  return session;
}

export async function loadSession(req) {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = await SsoSession.findOne({ sessionId });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  const user = await SsoUser.findById(session.userId);
  if (!user || user.status !== 'active') return null;
  const tenant = user.tenantId ? await SsoTenant.findById(user.tenantId) : null;
  if (tenant && tenant.status !== 'active') return null;
  return { session, user, tenant };
}

export const csrfOk = (req, session) => safeEqual(req.body?._csrf || '', session?.csrfToken || 'x');

export async function revokeSession(session) {
  if (!session) return;
  session.revokedAt = new Date();
  await session.save();
}
