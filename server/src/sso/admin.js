// Administrative dashboard: platform administrators manage tenants; tenant administrators manage their own
// users, applications, MFA/provider/token policy and audit trail. Every query is scoped to the tenant that
// the signed-in administrator is allowed to see.
import { Router } from 'express';
import {
  SsoAuditEvent, SsoClientApp, SsoSession, SsoTenant, SsoUser
} from './models.js';
import { audit, hashSecret, passwordProblems, randomToken } from './security.js';
import { csrfOk, issuerFrom, loadSession } from './session.js';
import * as views from './pages.js';

const router = Router();
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const PROVIDERS = ['google', 'facebook'];

router.use(wrap(async (req, res, next) => {
  const loaded = await loadSession(req);
  if (!loaded) return res.redirect(`/login?return_to=${encodeURIComponent(req.originalUrl)}`);
  if (!['platform_admin', 'tenant_admin'].includes(loaded.user.role)) {
    return res.status(403).send(views.errorPage({ title: 'Administration access required', message: 'Your account does not have administrative rights for any organisation.' }));
  }
  req.sso = loaded;
  next();
}));

const wrapAll = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const requireCsrf = (req, res, next) => (csrfOk(req, req.sso.session) ? next() : res.status(400).send(views.errorPage({ title: 'Form expired', message: 'Reload the dashboard and try again.' })));
const isPlatform = req => req.sso.user.role === 'platform_admin';
const tenantScope = req => (isPlatform(req) ? null : req.sso.user.tenantId);

/** The tenant an administrator is currently working on — never taken from the client for tenant admins. */
async function currentTenant(req) {
  const scoped = tenantScope(req);
  if (scoped) return SsoTenant.findById(scoped);
  const requested = req.query?.tenant || req.body?.tenant;
  if (requested) return SsoTenant.findById(requested);
  return SsoTenant.findOne().sort({ createdAt: 1 });
}

async function visibleTenants(req) {
  const scoped = tenantScope(req);
  if (scoped) return SsoTenant.find({ _id: scoped });
  return SsoTenant.find().sort({ createdAt: 1 });
}

const tenantFilter = (req, tenant) => (tenantScope(req) ? { tenantId: tenantScope(req) } : { tenantId: tenant?._id || null });

function viewTenant(tenant) {
  if (!tenant) return null;
  const plain = typeof tenant.toObject === 'function' ? tenant.toObject() : { ...tenant };
  const settings = plain.settings || {};
  const providers = {};
  for (const name of PROVIDERS) {
    const settingsForProvider = settings.providers?.[name] || {};
    providers[name] = { enabled: !!settingsForProvider.enabled, clientId: settingsForProvider.clientId || '', hasSecret: !!settingsForProvider.clientSecret };
  }
  return { _id: plain._id, name: plain.name, slug: plain.slug, status: plain.status, settings: { ...settings, providers } };
}

const withSecrets = tenantId => SsoTenant.findById(tenantId).select('+settings.providers.google.clientSecret +settings.providers.facebook.clientSecret');

async function recentEvents(req, tenant, { type = '', limit = 15 } = {}) {
  const filter = tenantScope(req) ? { tenantId: tenantScope(req) } : (tenant ? { tenantId: tenant._id } : {});
  if (type) filter.type = type;
  return SsoAuditEvent.find(filter).sort({ createdAt: -1 }).limit(limit);
}

async function countsFor(req, tenant) {
  const scope = tenantFilter(req, tenant);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [users, apps, failed, locked, sessions] = await Promise.all([
    SsoUser.countDocuments(scope),
    SsoClientApp.countDocuments(scope),
    SsoAuditEvent.countDocuments({ ...scope, type: { $in: ['login.failure', 'login.lockout', 'mfa.failure'] }, createdAt: { $gte: weekAgo } }),
    SsoUser.countDocuments({ ...scope, lockedUntil: { $gt: new Date() } }),
    SsoSession.countDocuments({ ...scope, revokedAt: null, expiresAt: { $gt: new Date() } })
  ]);
  const tenants = isPlatform(req) ? await SsoTenant.countDocuments() : 1;
  return { tenants, users, apps, failed, locked, sessions };
}

router.get('/', wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  const [counts, events, tenants] = await Promise.all([countsFor(req, tenant), recentEvents(req, tenant, { limit: 12 }), isPlatform(req) ? SsoTenant.find().sort({ createdAt: 1 }) : Promise.resolve([])]);
  res.send(views.adminOverview({
    user: req.sso.user,
    tenant,
    counts,
    events,
    tenants,
    csrf: req.sso.session.csrfToken,
    notice: String(req.query.notice || ''),
    error: String(req.query.error || '')
  }));
}));

// --- Tenants (platform administrators) ---------------------------------------------------------------
router.get('/tenants', wrap(async (req, res) => {
  if (!isPlatform(req)) return res.redirect('/admin');
  const tenants = await SsoTenant.find().sort({ createdAt: 1 });
  res.send(views.adminTenantsPage({ user: req.sso.user, tenants, csrf: req.sso.session.csrfToken, notice: String(req.query.notice || ''), error: String(req.query.error || '') }));
}));

router.post('/tenants', requireCsrf, wrap(async (req, res) => {
  if (!isPlatform(req)) return res.status(403).send(views.errorPage({ title: 'Not permitted', message: 'Only a platform administrator can create tenants.' }));
  const name = String(req.body?.name || '').trim();
  const slug = String(req.body?.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!name || !slug) return res.redirect('/admin/tenants?error=' + encodeURIComponent('A name and an identifier are required.'));
  if (await SsoTenant.exists({ slug })) return res.redirect('/admin/tenants?error=' + encodeURIComponent('That identifier is already in use.'));
  const tenant = await SsoTenant.create({ name, slug });
  await audit({ tenantId: tenant._id, type: 'admin.tenant_created', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: slug });
  return res.redirect('/admin/tenants?notice=' + encodeURIComponent(`Tenant ${name} created.`));
}));

router.post('/tenants/:id/status', requireCsrf, wrap(async (req, res) => {
  if (!isPlatform(req)) return res.status(403).send(views.errorPage({ title: 'Not permitted', message: 'Only a platform administrator can change tenant status.' }));
  const status = req.body?.status === 'active' ? 'active' : 'suspended';
  await SsoTenant.updateOne({ _id: req.params.id }, { $set: { status } });
  await audit({ tenantId: req.params.id, type: 'admin.tenant_status_changed', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: status });
  return res.redirect('/admin/tenants?notice=' + encodeURIComponent(`Tenant ${status === 'active' ? 'activated' : 'deactivated'}.`));
}));

// --- One tenant: settings, users, applications -------------------------------------------------------
router.get('/tenant', wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  if (!tenant) return res.redirect('/admin?error=' + encodeURIComponent('No tenant selected.'));
  const detailed = await withSecrets(tenant._id);
  const scope = { tenantId: tenant._id };
  const [users, apps, events, tenants] = await Promise.all([
    SsoUser.find(scope).sort({ createdAt: 1 }),
    SsoClientApp.find(scope).sort({ createdAt: 1 }),
    recentEvents(req, tenant, { limit: 12 }),
    isPlatform(req) ? SsoTenant.find().sort({ createdAt: 1 }) : Promise.resolve([])
  ]);
  res.send(views.adminTenantPage({
    user: req.sso.user,
    tenant: viewTenant(detailed),
    tenants,
    users,
    apps,
    events,
    csrf: req.sso.session.csrfToken,
    notice: String(req.query.notice || ''),
    error: String(req.query.error || ''),
    issuer: issuerFrom(req)
  }));
}));

router.post('/tenant/settings', requireCsrf, wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  if (!tenant) return res.redirect('/admin?error=' + encodeURIComponent('No tenant selected.'));
  if (!isPlatform(req) && String(req.sso.user.tenantId) !== String(tenant._id)) {
    return res.status(403).send(views.errorPage({ title: 'Not permitted', message: 'You can only change your own organisation.' }));
  }
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(Math.round(number), min), max);
  };
  const update = {
    'settings.mfa': ['off', 'optional', 'required'].includes(String(req.body?.mfa)) ? String(req.body.mfa) : 'off',
    'settings.accessTokenSeconds': clamp(req.body?.accessTokenSeconds, 300, 3600, 900),
    'settings.refreshTokenSeconds': clamp(req.body?.refreshTokenSeconds, 3600, 2592000, 1209600),
    'settings.sessionLifetimeSeconds': clamp(req.body?.sessionLifetimeSeconds, 900, 604800, 43200),
    'settings.passwordMinLength': clamp(req.body?.passwordMinLength, 8, 128, 10),
    'settings.maxFailedLogins': clamp(req.body?.maxFailedLogins, 3, 20, 5),
    'settings.lockoutMinutes': clamp(req.body?.lockoutMinutes, 1, 1440, 15)
  };
  for (const provider of PROVIDERS) {
    update[`settings.providers.${provider}.enabled`] = String(req.body?.[`${provider}Enabled`] || 'off') === 'on';
    const clientId = String(req.body?.[`${provider}ClientId`] || '').trim();
    if (clientId) update[`settings.providers.${provider}.clientId`] = clientId;
    const secret = String(req.body?.[`${provider}Secret`] || '');
    if (secret) update[`settings.providers.${provider}.clientSecret`] = secret;
  }
  await SsoTenant.updateOne({ _id: tenant._id }, { $set: update });
  await audit({ tenantId: tenant._id, type: 'admin.settings_updated', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: `mfa=${update['settings.mfa']}` });
  return res.redirect(`/admin/tenant?tenant=${tenant._id}&notice=` + encodeURIComponent('Settings saved.'));
}));

router.post('/tenant/users', requireCsrf, wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  if (!tenant) return res.redirect('/admin?error=' + encodeURIComponent('No tenant selected.'));
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const role = req.body?.role === 'tenant_admin' ? 'tenant_admin' : 'member';
  if (!email || !name) return res.redirect(`/admin/tenant?tenant=${tenant._id}&error=` + encodeURIComponent('A name and email are required.'));
  if (await SsoUser.exists({ tenantId: tenant._id, email })) return res.redirect(`/admin/tenant?tenant=${tenant._id}&error=` + encodeURIComponent('That email already exists in this organisation.'));
  const problem = passwordProblems(req.body?.password, tenant.settings?.passwordMinLength || 10);
  if (problem) return res.redirect(`/admin/tenant?tenant=${tenant._id}&error=` + encodeURIComponent(problem));
  const user = await SsoUser.create({ tenantId: tenant._id, email, name, role, passwordHash: await hashSecret(req.body.password, 12) });
  await audit({ tenantId: tenant._id, type: 'admin.user_created', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: email });
  return res.redirect(`/admin/tenant?tenant=${tenant._id}&notice=` + encodeURIComponent(`User ${name} created.`));
}));

router.post('/tenant/users/:id', requireCsrf, wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  const user = await SsoUser.findOne({ _id: req.params.id, tenantId: tenant?._id });
  if (!tenant || !user) return res.status(404).send(views.errorPage({ title: 'User not found', message: 'That user does not belong to this organisation.' }));
  const action = String(req.body?.action || '');
  const back = `/admin/tenant?tenant=${tenant._id}`;
  if (action === 'toggle-status') {
    user.status = req.body?.status === 'active' ? 'active' : 'suspended';
    await user.save();
    if (user.status === 'suspended') {
      await SsoSession.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    await audit({ tenantId: tenant._id, type: 'admin.user_status_changed', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: `${user.email} ${user.status}` });
    return res.redirect(`${back}&notice=` + encodeURIComponent(`${user.name} is now ${user.status}.`));
  }
  if (action === 'unlock') {
    user.lockedUntil = undefined;
    user.failedLogins = 0;
    await user.save();
    await audit({ tenantId: tenant._id, type: 'admin.user_unlocked', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: user.email });
    return res.redirect(`${back}&notice=` + encodeURIComponent(`${user.name} unlocked.`));
  }
  if (action === 'reset-mfa') {
    await SsoUser.updateOne({ _id: user._id }, { $set: { 'mfa.enabled': false, 'mfa.secret': '', 'mfa.recoveryCodes': [], 'mfa.pendingSecret': '' } });
    await audit({ tenantId: tenant._id, type: 'admin.user_mfa_reset', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: user.email });
    return res.redirect(`${back}&notice=` + encodeURIComponent(`Two-factor authentication reset for ${user.name}.`));
  }
  if (action === 'set-password') {
    const problem = passwordProblems(req.body?.password, tenant.settings?.passwordMinLength || 10);
    if (problem) return res.redirect(`${back}&error=` + encodeURIComponent(problem));
    await SsoUser.updateOne({ _id: user._id }, { $set: { passwordHash: await hashSecret(req.body.password, 12), passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null } });
    await SsoSession.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit({ tenantId: tenant._id, type: 'admin.user_password_reset', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: user.email });
    return res.redirect(`${back}&notice=` + encodeURIComponent(`Password reset for ${user.name}; their sessions were signed out.`));
  }
  return res.redirect(`${back}&error=` + encodeURIComponent('Unknown action.'));
}));

router.post('/tenant/apps', requireCsrf, wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  if (!tenant) return res.redirect('/admin?error=' + encodeURIComponent('No tenant selected.'));
  const name = String(req.body?.name || '').trim();
  const type = req.body?.type === 'public' ? 'public' : 'confidential';
  const redirectUris = String(req.body?.redirectUris || '').split(/[\s,]+/).map(uri => uri.trim()).filter(Boolean);
  if (!name || !redirectUris.length) return res.redirect(`/admin/tenant?tenant=${tenant._id}&error=` + encodeURIComponent('An application name and at least one redirect URI are required.'));
  if (redirectUris.some(uri => !/^https?:\/\/|^[a-z][a-z0-9+.-]*:\/\//i.test(uri))) {
    return res.redirect(`/admin/tenant?tenant=${tenant._id}&error=` + encodeURIComponent('Redirect URIs must be absolute URLs.'));
  }
  const clientId = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)}-${randomToken(4)}`;
  const clientSecret = randomToken(32);
  await SsoClientApp.create({
    tenantId: tenant._id,
    name,
    description: String(req.body?.description || '').slice(0, 500),
    clientId,
    clientSecretHash: type === 'confidential' ? await hashSecret(clientSecret, 12) : '',
    type,
    redirectUris
  });
  await audit({ tenantId: tenant._id, type: 'admin.client_app_registered', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: clientId });
  const detailed = await withSecrets(tenant._id);
  const [users, apps, events, tenants] = await Promise.all([
    SsoUser.find({ tenantId: tenant._id }).sort({ createdAt: 1 }),
    SsoClientApp.find({ tenantId: tenant._id }).sort({ createdAt: 1 }),
    recentEvents(req, tenant, { limit: 12 }),
    isPlatform(req) ? SsoTenant.find().sort({ createdAt: 1 }) : Promise.resolve([])
  ]);
  // The plaintext secret is shown once, on this response only; it is stored hashed.
  return res.send(views.adminTenantPage({
    user: req.sso.user,
    tenant: viewTenant(detailed),
    tenants,
    users,
    apps,
    events,
    csrf: req.sso.session.csrfToken,
    createdApp: { name, clientId, clientSecret: type === 'confidential' ? clientSecret : '(public client — PKCE only, no secret)' },
    issuer: issuerFrom(req)
  }));
}));

router.post('/tenant/apps/:id', requireCsrf, wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  const app = await SsoClientApp.findOne({ _id: req.params.id, tenantId: tenant?._id });
  if (!app) return res.status(404).send(views.errorPage({ title: 'Application not found', message: 'That application does not belong to this organisation.' }));
  app.active = String(req.body?.active) === 'true';
  await app.save();
  if (!app.active) {
    // Disabling an application immediately invalidates its outstanding sessions' refresh tokens.
    await SsoSession.updateMany({ tenantId: tenant._id, revokedAt: null, userId: req.sso.user._id }, { $set: {} });
  }
  await audit({ tenantId: tenant._id, type: 'admin.client_app_status_changed', actorId: req.sso.user._id, actorEmail: req.sso.user.email, req, detail: `${app.clientId} ${app.active ? 'enabled' : 'disabled'}` });
  return res.redirect(`/admin/tenant?tenant=${tenant._id}&notice=` + encodeURIComponent(`${app.name} ${app.active ? 'enabled' : 'disabled'}.`));
}));

// --- Audit trail --------------------------------------------------------------------------------------
router.get('/audit', wrap(async (req, res) => {
  const tenant = await currentTenant(req);
  const type = String(req.query.type || '').slice(0, 60);
  const events = await recentEvents(req, tenant, { type, limit: 200 });
  res.send(views.auditPage({ user: req.sso.user, tenant, events, filter: type, csrf: req.sso.session.csrfToken }));
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('SSO admin request failed:', error.message);
  return res.status(500).send(views.errorPage({ title: 'Something went wrong', message: 'The dashboard request could not be completed.' }));
});

export default router;
export { wrapAll };
