// Idempotent demo data for the SSO platform: one tenant, three accounts and the two sample client
// applications. Safe to run on every boot — it creates only what is missing and refreshes the demo
// applications' redirect URIs so a changing preview host can never break the flows.
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { pathToFileURL } from 'url';
import { SsoClientApp, SsoTenant, SsoUser } from './models.js';
import { audit } from './security.js';

export const DEMO_PASSWORD = process.env.SSO_DEMO_PASSWORD || 'Demo@12345';

// Provider credentials normally come from the administration dashboard, per tenant. When real credentials are
// supplied through the environment instead, the demo tenant is provisioned from them — but only where nothing is
// configured yet: credentials an administrator saved are never overwritten, and the seed never switches a
// provider on (that stays a tenant decision in the dashboard).
const PROVIDER_CREDENTIAL_ENV = {
  google: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  facebook: { clientId: 'FACEBOOK_CLIENT_ID', clientSecret: 'FACEBOOK_CLIENT_SECRET' }
};

async function provisionProviderCredentials(tenant) {
  const supplied = Object.entries(PROVIDER_CREDENTIAL_ENV)
    .filter(([, names]) => process.env[names.clientId] && process.env[names.clientSecret]);
  if (!supplied.length) return [];
  // Client secrets are excluded from ordinary queries, so read the tenant back with them selected.
  const detailed = await SsoTenant.findById(tenant._id).select('+settings.providers.google.clientSecret +settings.providers.facebook.clientSecret');
  const update = {};
  const applied = [];
  for (const [provider, names] of supplied) {
    const clientId = String(process.env[names.clientId]).trim();
    const clientSecret = String(process.env[names.clientSecret]).trim();
    const current = detailed.settings?.providers?.[provider] || {};
    if (current.clientId || current.clientSecret) continue;
    update[`settings.providers.${provider}.clientId`] = clientId;
    update[`settings.providers.${provider}.clientSecret`] = clientSecret;
    applied.push(provider);
  }
  if (applied.length) {
    await SsoTenant.updateOne({ _id: tenant._id }, { $set: update });
    await audit({ tenantId: tenant._id, type: 'provider.credentials_provisioned', detail: applied.join(', ') });
  }
  return applied;
}

const demoUsers = tenant => [
  { tenantId: null, email: 'sso_admin@comsats.edu.pk', name: 'SSO Platform Admin', role: 'platform_admin' },
  { tenantId: tenant._id, email: 'tenant_admin@comsats.edu.pk', name: 'Tenant Admin', role: 'tenant_admin' },
  { tenantId: tenant._id, email: 'student@comsats.edu.pk', name: 'Sso Student', role: 'member' }
];

const demoTenants = [
  { slug: 'comsats', name: 'COMSATS University Islamabad' },
  { slug: 'north-campus', name: 'North Campus Institute' }
];

/**
 * Creates/refreshes the demo tenant, its accounts and the two registered client applications.
 * The Campus Portal and Library Desk secrets come from the environment so the sample apps can exchange codes.
 */
export async function seedSsoDatabase() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const tenants = {};
  for (const definition of demoTenants) {
    const tenant = await SsoTenant.findOneAndUpdate(
      { slug: definition.slug },
      { $set: { name: definition.name, status: 'active' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    tenants[definition.slug] = tenant;
  }

  for (const definition of demoUsers(tenants.comsats)) {
    const existing = await SsoUser.findOne({ tenantId: definition.tenantId, email: definition.email });
    if (!existing) {
      await SsoUser.create({ ...definition, passwordHash, emailVerified: true });
      continue;
    }
    // Never reset an existing account's password or MFA state — only its descriptive fields.
    await SsoUser.updateOne({ _id: existing._id }, { $set: { name: definition.name, role: definition.role } });
  }

  const portalUrl = process.env.DEMO_PORTAL_URL || 'http://localhost:9101';
  const libraryUrl = process.env.DEMO_LIBRARY_URL || 'http://localhost:9102';
  const apps = [
    { name: 'Campus Portal', clientId: 'campus-portal', secret: process.env.PORTAL_CLIENT_SECRET || 'campus-portal-demo-secret', redirect: `${portalUrl}/callback`, description: 'Sample first-party client: student portal.' },
    { name: 'Library Desk', clientId: 'library-desk', secret: process.env.LIBRARY_CLIENT_SECRET || 'library-desk-demo-secret', redirect: `${libraryUrl}/callback`, description: 'Sample first-party client: library desk.' }
  ];
  for (const definition of apps) {
    const existing = await SsoClientApp.findOne({ clientId: definition.clientId });
    const update = {
      tenantId: tenants.comsats._id,
      name: definition.name,
      description: definition.description,
      type: 'confidential',
      redirectUris: [definition.redirect],
      postLogoutRedirectUris: [definition.redirect.replace('/callback', '/')],
      scopes: ['openid', 'profile', 'email'],
      active: true
    };
    if (existing) {
      await SsoClientApp.updateOne({ _id: existing._id }, { $set: update });
      // Keep the configured secret in step with the environment (development convenience only).
      if (!await bcrypt.compare(definition.secret, (await SsoClientApp.findById(existing._id).select('+clientSecretHash')).clientSecretHash || '')) {
        await SsoClientApp.updateOne({ _id: existing._id }, { $set: { clientSecretHash: await bcrypt.hash(definition.secret, 12) } });
      }
    } else {
      await SsoClientApp.create({ ...update, clientId: definition.clientId, clientSecretHash: await bcrypt.hash(definition.secret, 12) });
    }
  }
  const providers = await provisionProviderCredentials(tenants.comsats);
  return { tenant: tenants.comsats, clientApps: apps.length, clientIds: apps.map(app => app.clientId), providers };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing. Set it before running the SSO seed.');
  await mongoose.connect(process.env.MONGO_URI);
  const result = await seedSsoDatabase();
  console.log(`SSO seed complete: tenant "${result.tenant.name}", ${result.clientApps} client applications (${result.clientIds.join(', ')}).`);
  if (result.providers.length) console.log(`Provider credentials supplied by the environment were stored for: ${result.providers.join(', ')} — enable each provider per tenant in the dashboard to show its sign-in button.`);
  console.log(`Demo password for the SSO accounts: ${DEMO_PASSWORD}`);
  await mongoose.disconnect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => { console.error('SSO seed failed:', error.message); await mongoose.disconnect().catch(() => {}); process.exitCode = 1; });
}
