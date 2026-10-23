import mongoose from 'mongoose';
const { Schema, model } = mongoose;

export const ROLE_VALUES = ['Technical Admin', 'Rector', 'Campus Incharge', 'HOD', 'Department Coordinator', 'Teacher', 'Student', 'Employee account'];
const assignmentSchema = new Schema({
  role: { type: String, enum: ROLE_VALUES, required: true },
  campus: { type: String, default: '' },
  department: { type: String, default: '' },
  scope: { type: String, enum: ['university', 'campus', 'department', 'class', 'functional'], default: 'department' },
  permissions: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  assignedAt: { type: Date, default: Date.now },
  revokedAt: Date
}, { _id: true });

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLE_VALUES, default: 'Student' },
  campus: { type: String, default: '' },
  department: { type: String, default: '' },
  assignments: { type: [assignmentSchema], default: [] },
  status: { type: String, enum: ['active', 'suspended', 'deactivated'], default: 'active' },
  avatarColor: { type: String, default: '#176b55' },
  lastSeen: Date,
  securityVersion: { type: Number, default: 1 },
  // Second factor (TOTP). The shared secret is stored encrypted with AES-256-GCM and never selected by default,
  // and recovery codes are kept only as bcrypt hashes, so this collection holds no usable credential.
  mfa: {
    enabled: { type: Boolean, default: false },
    secret: { type: String, default: '', select: false },
    pendingSecret: { type: String, default: '', select: false },
    pendingCreatedAt: Date,
    recoveryCodes: { type: [{ _id: false, hash: String, usedAt: Date }], default: [], select: false },
    // The last accepted time step, so an observed code cannot be replayed.
    lastStep: { type: Number, default: -1 },
    enabledAt: Date,
    attempts: { type: Number, default: 0 },
    lockedUntil: Date
  },
  // Password backoff, counted per account (the preview proxy hides client IPs, so per-IP limits stay lenient).
  failedLogins: { type: Number, default: 0 },
  lockedUntil: Date
}, { timestamps: true });

const messageSchema = new Schema({
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true, maxlength: 5000 },
  createdAt: { type: Date, default: Date.now },
  readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }]
});
const conversationSchema = new Schema({
  participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  requestState: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'accepted' },
  requestSender: { type: Schema.Types.ObjectId, ref: 'User' },
  recipientCanResubmit: { type: Boolean, default: false },
  blockedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  relationshipSnapshot: { type: Schema.Types.Mixed, default: {} },
  messages: [messageSchema],
  lastMessageAt: Date
}, { timestamps: true });

const membershipPeriodSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  joinedAt: { type: Date, default: Date.now },
  leftAt: { type: Date, default: null },
  reason: { type: String, default: 'membership' }
});
const delegationSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  grantedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  capabilities: { type: [String], default: [] },
  scope: { type: String, default: 'group' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  revokedAt: Date
});
const joinRequestSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'approved', 'declined'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date
});
const invitationSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  decidedAt: Date
});
const groupSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, maxlength: 2000, default: '' },
  type: { type: String, enum: ['discussion', 'announcement', 'mixed'], default: 'discussion' },
  scope: { type: String, enum: ['university', 'campus', 'department', 'class', 'functional', 'personal'], default: 'personal' },
  campus: { type: String, default: '' },
  department: { type: String, default: '' },
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  eligibleRoles: { type: [String], enum: ROLE_VALUES, default: ROLE_VALUES },
  membershipHistory: { type: [membershipPeriodSchema], default: [] },
  joinRequests: { type: [joinRequestSchema], default: [] },
  managers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  delegations: { type: [delegationSchema], default: [] },
  visibility: { type: String, enum: ['private', 'approval', 'open'], default: 'private' },
  // Who may broadcast to this group. Official groups are governed by postingRoles + scoped permissions; informal groups by this policy.
  postingPolicy: { type: String, enum: ['owner', 'publishers', 'members'], default: 'owner' },
  allowMemberDirectMessages: { type: Boolean, default: false },
  postingRoles: { type: [String], default: ['Rector', 'Campus Incharge', 'HOD', 'Department Coordinator', 'Teacher', 'Student', 'Employee account'] },
  publishers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  // Informal-group invitations: a user becomes a member (and a broadcast recipient) only after accepting.
  invitations: { type: [invitationSchema], default: [] },
  // Users manually removed from an auto-enrolled group are never silently re-added.
  removedUsers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  // Official default groups (Everyone / campus / department) enroll matching accounts automatically.
  autoEnroll: { type: Boolean, default: false },
  archived: { type: Boolean, default: false },
  archivedAt: Date,
  requiresOwnerIntervention: { type: Boolean, default: false },
  // DEPRECATED (read-only legacy data): the former shared group timeline. No route reads or writes it;
  // it is retained only so existing databases are never silently destroyed. See docs/MIGRATION.md.
  messages: { type: [messageSchema], select: false }
}, { timestamps: true });
groupSchema.index({ scope: 1, campus: 1, department: 1, archived: 1 });
groupSchema.index({ members: 1 });
groupSchema.index({ name: 1, campus: 1 });

// A broadcast is ONE logical message. Per-recipient inbox entries are Delivery documents that reference it.
const broadcastSchema = new Schema({
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  body: { type: String, required: true, maxlength: 5000 },
  // Audience snapshot: the groups the sender selected, with names frozen at send time.
  groups: [{ _id: { type: Schema.Types.ObjectId, ref: 'Group' }, name: String, scope: String }],
  // Client-generated idempotency key. (sender, clientMessageId) is unique so retries cannot duplicate a broadcast.
  clientMessageId: { type: String, required: true, maxlength: 80 },
  status: { type: String, enum: ['pending', 'delivered'], default: 'pending' },
  recipientCount: { type: Number, default: 0 }
}, { timestamps: true });
broadcastSchema.index({ sender: 1, clientMessageId: 1 }, { unique: true });
broadcastSchema.index({ sender: 1, _id: -1 });
broadcastSchema.index({ status: 1, createdAt: 1 });

const deliverySchema = new Schema({
  broadcast: { type: Schema.Types.ObjectId, ref: 'Broadcast', required: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // The selected groups through which this recipient was reached (a user in several groups still gets ONE delivery).
  via: [{ type: Schema.Types.ObjectId, ref: 'Group' }],
  readAt: { type: Date, default: null }
}, { timestamps: true });
deliverySchema.index({ broadcast: 1, recipient: 1 }, { unique: true });
deliverySchema.index({ recipient: 1, _id: -1 });
deliverySchema.index({ recipient: 1, readAt: 1 });

const auditSchema = new Schema({
  actor: { type: Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  resourceType: String,
  resourceId: String,
  scope: String,
  outcome: { type: String, default: 'success' },
  metadata: Schema.Types.Mixed
}, { timestamps: true });

// Signed-in sessions: one *family* is one signed-in device. Only the SHA-256 hash of a refresh token is stored,
// so the database never holds a usable credential. Rotation and reuse detection live in services/tokens.js.
const refreshTokenSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  familyId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  // The account security version at issue time: a password, role or status change invalidates outstanding sessions.
  securityVersion: { type: Number, required: true },
  userAgent: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  revokedReason: { type: String, default: '' }
}, { timestamps: true });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const User = model('User', userSchema);
export const RefreshToken = model('RefreshToken', refreshTokenSchema);
export const Conversation = model('Conversation', conversationSchema);
export const Group = model('Group', groupSchema);
export const AuditLog = model('AuditLog', auditSchema);
export const Broadcast = model('Broadcast', broadcastSchema);
export const Delivery = model('Delivery', deliverySchema);
