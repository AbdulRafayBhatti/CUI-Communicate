// Multi-tenant SSO data model. Deliberately separate from the messaging models: the SSO platform owns its own
// users, tenants, client applications and tokens, so adding it cannot change the messaging authorization model.
import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const providerSchema = () => new Schema({
  enabled: { type: Boolean, default: false },
  clientId: { type: String, default: '' },
  clientSecret: { type: String, default: '', select: false }
}, { _id: false });

const tenantSettingsSchema = new Schema({
  // off = MFA never required, optional = users may enrol, required = every user must use TOTP.
  mfa: { type: String, enum: ['off', 'optional', 'required'], default: 'off' },
  // Token/session lifetimes are clamped to safe platform limits by the schema itself.
  accessTokenSeconds: { type: Number, default: 900, min: 300, max: 3600 },
  refreshTokenSeconds: { type: Number, default: 1209600, min: 3600, max: 2592000 },
  sessionLifetimeSeconds: { type: Number, default: 43200, min: 900, max: 604800 },
  passwordMinLength: { type: Number, default: 10, min: 8, max: 128 },
  maxFailedLogins: { type: Number, default: 5, min: 3, max: 20 },
  lockoutMinutes: { type: Number, default: 15, min: 1, max: 1440 },
  providers: { google: providerSchema(), facebook: providerSchema() }
}, { _id: false });

const tenantSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  settings: { type: tenantSettingsSchema, default: () => ({}) }
}, { timestamps: true, collection: 'sso_tenants' });

const ssoUserSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'SsoTenant', default: null, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['platform_admin', 'tenant_admin', 'member'], default: 'member' },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  emailVerified: { type: Boolean, default: true },
  mfa: {
    enabled: { type: Boolean, default: false },
    secret: { type: String, default: '', select: false },
    pendingSecret: { type: String, default: '', select: false },
    recoveryCodes: { type: [{ _id: false, hash: String, usedAt: Date }], default: [], select: false },
    enrolledAt: Date
  },
  socialIdentities: [{ _id: false, provider: String, providerUserId: String, email: String, linkedAt: { type: Date, default: Date.now } }],
  failedLogins: { type: Number, default: 0 },
  lockedUntil: Date,
  lastLoginAt: Date,
  passwordChangedAt: Date
}, { timestamps: true, collection: 'sso_users' });
ssoUserSchema.index({ tenantId: 1, email: 1 }, { unique: true });

const clientAppSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'SsoTenant', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', maxlength: 500 },
  clientId: { type: String, required: true, unique: true },
  clientSecretHash: { type: String, default: '', select: false },
  type: { type: String, enum: ['confidential', 'public'], default: 'confidential' },
  redirectUris: { type: [String], default: [] },
  postLogoutRedirectUris: { type: [String], default: [] },
  scopes: { type: [String], default: ['openid', 'profile', 'email'] },
  active: { type: Boolean, default: true }
}, { timestamps: true, collection: 'sso_client_apps' });

const authCodeSchema = new Schema({
  codeHash: { type: String, required: true, unique: true },
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  clientId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  scope: { type: String, default: 'openid' },
  nonce: { type: String, default: '' },
  codeChallenge: { type: String, default: '' },
  codeChallengeMethod: { type: String, default: '' },
  sessionId: { type: Schema.Types.ObjectId },
  expiresAt: { type: Date, required: true },
  usedAt: Date
}, { timestamps: true, collection: 'sso_auth_codes' });
authCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const refreshTokenSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  tenantId: { type: Schema.Types.ObjectId, default: null, index: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  clientId: { type: String, required: true },
  // Every rotation stays in the same family; replaying a rotated token revokes the whole family.
  family: { type: String, required: true, index: true },
  scope: { type: String, default: 'openid' },
  sessionId: { type: Schema.Types.ObjectId },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  usedAt: Date,
  replacedBy: { type: String, default: '' }
}, { timestamps: true, collection: 'sso_refresh_tokens' });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const sessionSchema = new Schema({
  sessionId: { type: String, required: true, unique: true },
  tenantId: { type: Schema.Types.ObjectId, default: null, index: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  csrfToken: { type: String, required: true },
  mfaVerifiedAt: Date,
  authMethods: { type: [String], default: [] },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
  revokedAt: Date
}, { timestamps: true, collection: 'sso_sessions' });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const passwordResetSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  tenantId: { type: Schema.Types.ObjectId, default: null },
  expiresAt: { type: Date, required: true },
  usedAt: Date
}, { timestamps: true, collection: 'sso_password_resets' });
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const socialStateSchema = new Schema({
  state: { type: String, required: true, unique: true },
  provider: { type: String, required: true },
  tenantId: { type: Schema.Types.ObjectId, default: null },
  clientId: { type: String, default: '' },
  returnTo: { type: String, default: '' },
  codeVerifier: { type: String, default: '' },
  nonce: { type: String, default: '' },
  expiresAt: { type: Date, required: true }
}, { timestamps: true, collection: 'sso_social_states' });
socialStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const auditEventSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, default: null, index: true },
  type: { type: String, required: true, index: true },
  outcome: { type: String, enum: ['success', 'failure', 'denied'], default: 'success' },
  actorId: { type: Schema.Types.ObjectId, default: null },
  actorEmail: { type: String, default: '' },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  detail: { type: String, default: '' }
}, { timestamps: true, collection: 'sso_audit_events' });
auditEventSchema.index({ createdAt: -1 });

const signingKeySchema = new Schema({
  kid: { type: String, required: true, unique: true },
  algorithm: { type: String, default: 'RS256' },
  privatePem: { type: String, required: true },
  publicPem: { type: String, required: true },
  active: { type: Boolean, default: true }
}, { timestamps: true, collection: 'sso_signing_keys' });

export const SsoTenant = model('SsoTenant', tenantSchema);
export const SsoUser = model('SsoUser', ssoUserSchema);
export const SsoClientApp = model('SsoClientApp', clientAppSchema);
export const SsoAuthorizationCode = model('SsoAuthorizationCode', authCodeSchema);
export const SsoRefreshToken = model('SsoRefreshToken', refreshTokenSchema);
export const SsoSession = model('SsoSession', sessionSchema);
export const SsoPasswordReset = model('SsoPasswordReset', passwordResetSchema);
export const SsoSocialState = model('SsoSocialState', socialStateSchema);
export const SsoAuditEvent = model('SsoAuditEvent', auditEventSchema);
export const SsoSigningKey = model('SsoSigningKey', signingKeySchema);
