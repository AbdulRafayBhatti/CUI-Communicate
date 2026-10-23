import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { User, Conversation, Group } from '../models/index.js';
import { requireAuth, requireMfaEnrolled, safeUser } from '../middleware/auth.js';
import { notifyUser, notifyUsers } from '../services/realtime.js';
import { syncDefaultMemberships, enrollEligibleInGroup } from '../services/enrollment.js';
import broadcastRoutes from './broadcasts.js';
import {
  ROLES, audit, canAssignRole, canCreateGroup, canDirectWithoutRequest,
  canBroadcastToGroup, isEligibleForGroup, canManageGroup, canManageInstitutionalUsers, canOwnGroup, hasScopedPermission, hasRoleInScope, rolesInScope, isInOrgScope, relationshipSnapshot, relationshipSnapshotMatches
} from '../services/policy.js';

const router = Router();
const wrapAsync = handler => handler.constructor?.name === 'AsyncFunction' ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) : handler;
for (const method of ['get', 'post', 'patch', 'delete']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map(wrapAsync));
}
router.use(requireAuth);
// Privileged roles work through the messaging API only once their second factor is enrolled (see services/mfa.js).
router.use(requireMfaEnrolled);
router.use('/broadcasts', broadcastRoutes);
const id = value => String(value?._id ?? value ?? '');
const escaped = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const memberOf = (group, userId) => group.members.some(m => id(m) === id(userId));
const inGroupScope = (user, group) => {
  const target = { scope: group.scope, campus: group.campus, department: group.department };
  const eligibleRoles = Array.isArray(group.eligibleRoles) && group.eligibleRoles.length ? group.eligibleRoles : ROLES;
  if (!rolesInScope(user, target).some(role => eligibleRoles.includes(role))) return false;
  return isInOrgScope(user, target);
};

function canManageTargetScope(actor, target) {
  return !!target && canManageInstitutionalUsers(actor, target);
}

function managementFilter(actor) {
  const base = { status: { $ne: 'deactivated' }, role: { $ne: 'Technical Admin' } };
  const assignments = (actor.assignments || []).filter(a => a.active !== false && a.permissions?.includes('users:manage'));
  if (assignments.some(a => a.role === 'Rector' && a.scope === 'university' && !a.campus && !a.department)) return base;
  const clauses = [];
  for (const a of assignments) {
    if (a.role === 'Campus Incharge' && a.scope === 'campus' && a.campus) {
      clauses.push({ campus: a.campus, role: { $nin: ['Technical Admin', 'Rector', 'Campus Incharge'] } });
    }
    if (a.role === 'HOD' && a.scope === 'department' && a.campus && a.department) {
      clauses.push({ campus: a.campus, department: a.department, role: { $in: ['Department Coordinator', 'Teacher', 'Student', 'Employee account'] } });
    }
    if (a.role === 'Department Coordinator' && a.scope === 'department' && a.campus && a.department) {
      clauses.push({ campus: a.campus, department: a.department, role: { $in: ['Teacher', 'Student', 'Employee account'] } });
    }
  }
  if (!clauses.length) return null;
  return { ...base, $or: clauses };
}
function successionPriority(group, user) {
  const priorities = group.scope === 'university' ? ['Rector'] : group.scope === 'campus' ? ['Campus Incharge', 'Rector'] : group.scope === 'department' ? ['HOD', 'Department Coordinator'] : group.scope === 'class' ? ['Teacher'] : ['HOD', 'Department Coordinator', 'Teacher'];
  const index = priorities.indexOf(user.role);
  return index < 0 ? priorities.length + 1 : index;
}

async function revalidateGroupsForUser(changedUser, actor, reason = 'assignment-change') {
  const affected = await Group.find({ archived: false, $or: [{ owner: changedUser._id }, { managers: changedUser._id }, { 'delegations.user': changedUser._id }, { 'delegations.grantedBy': changedUser._id }] });
  for (const group of affected) {
    let changed = false;
    const canStillDelegate = changedUser.status === 'active' && canManageGroup(changedUser, group, 'groups:delegations:manage');
    if (!canStillDelegate) {
      for (const d of group.delegations) if (id(d.grantedBy) === id(changedUser._id) && d.active !== false) { d.active = false; d.revokedAt = new Date(); changed = true; }
    }
    const changedUserStillManager = changedUser.status === 'active' && canManageGroup(changedUser, group, 'groups:manage');
    if (!changedUserStillManager && id(group.owner) !== id(changedUser._id)) {
      group.managers = group.managers.filter(m => id(m) !== id(changedUser._id));
      for (const d of group.delegations) if (id(d.user) === id(changedUser._id) && d.active !== false) { d.active = false; d.revokedAt = new Date(); changed = true; }
      changed = true;
    }
    if (id(group.owner) === id(changedUser._id) && (changedUser.status !== 'active' || !canOwnGroup(changedUser, group))) {
      const managerIds = group.managers.filter(m => id(m) !== id(changedUser._id));
      const managers = await User.find({ _id: { $in: managerIds }, status: 'active' });
      const members = await User.find({ _id: { $in: group.members.filter(m => id(m) !== id(changedUser._id)) }, status: 'active' });
      const eligible = users => users.filter(u => memberOf(group, u._id) && inGroupScope(u, group) && canOwnGroup(u, group)).sort((a, b) => successionPriority(group, a) - successionPriority(group, b) || id(a._id).localeCompare(id(b._id)));
      const nextOwner = eligible(managers)[0] || eligible(members)[0];
      if (nextOwner) {
        const previousOwner = group.owner; group.owner = nextOwner._id; group.managers = group.managers.filter(m => id(m) !== id(nextOwner._id) && id(m) !== id(previousOwner));
        group.requiresOwnerIntervention = false;
        for (const d of group.delegations) if (id(d.grantedBy) === id(previousOwner) && d.active !== false) { d.active = false; d.revokedAt = new Date(); }
        await audit(actor, 'group.owner.succeeded', 'Group', group._id, group.scope, { previousOwner: id(previousOwner), newOwner: id(nextOwner._id), reason });
      } else {
        group.requiresOwnerIntervention = true;
        for (const d of group.delegations) if (id(d.grantedBy) === id(changedUser._id) && d.active !== false) { d.active = false; d.revokedAt = new Date(); }
        await audit(actor, 'group.owner.intervention_required', 'Group', group._id, group.scope, { formerOwner: id(changedUser._id), reason }, 'pending');
      }
      changed = true;
    }
    if (changed) await group.save();
  }
}

// Directory returns only public profile fields; no password hashes or internal assignments.
router.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const filter = { _id: { $ne: req.user._id }, status: 'active' };
  if (q) { const safeQ = escaped(q); filter.$or = [{ name: { $regex: safeQ, $options: 'i' } }, { email: { $regex: safeQ, $options: 'i' } }, { department: { $regex: safeQ, $options: 'i' } }]; }
  const users = await User.find(filter).select('name email role campus department avatarColor').limit(30);
  res.json(users);
});

router.get('/conversations', async (req, res) => {
  const rows = await Conversation.find({ participants: req.user._id }).populate('participants', 'name role campus department avatarColor status').sort({ lastMessageAt: -1, updatedAt: -1 });
  res.json(rows.map(c => {
    const value = c.toObject();
    if (c.requestState === 'pending' && !c.requestSender?.equals(req.user._id)) value.messages = value.messages.slice(-1);
    return value;
  }));
});

router.post('/conversations/request', rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const recipient = await User.findById(req.body.recipientId);
  if (!recipient || recipient.status !== 'active') return res.status(404).json({ message: 'User not found.' });
  if (recipient._id.equals(req.user._id)) return res.status(400).json({ message: 'You cannot message yourself.' });
  const body = String(req.body.message || '').trim();
  if (!body || body.length > 5000) return res.status(400).json({ message: 'The initial message must be 1–5000 characters.' });
  let c = await Conversation.findOne({ participants: { $all: [req.user._id, recipient._id], $size: 2 } });
  if (c?.blockedBy?.length) return res.status(403).json({ message: 'This conversation is restricted.' });
  if (c?.requestState === 'pending') return res.status(409).json({ message: 'A message request is already pending.' });
  if (c?.requestState === 'declined' && c.requestSender?.equals(req.user._id) && !c.recipientCanResubmit) return res.status(403).json({ message: 'The recipient has not allowed you to resubmit this request.' });
  const direct = await canDirectWithoutRequest(req.user, recipient);
  if (c?.requestState === 'accepted') {
    if (await relationshipSnapshotMatches(c.relationshipSnapshot, req.user, recipient) || direct) {
      if (direct && !(await relationshipSnapshotMatches(c.relationshipSnapshot, req.user, recipient))) { c.relationshipSnapshot = await relationshipSnapshot(req.user, recipient); await c.save(); }
      return res.json(c);
    }
    // Organizational eligibility changed; re-establish contact through a fresh one-message request.
    c.requestState = 'pending'; c.requestSender = req.user._id; c.recipientCanResubmit = false; c.relationshipSnapshot = await relationshipSnapshot(req.user, recipient);
    c.messages.push({ sender: req.user._id, body }); c.lastMessageAt = new Date(); await c.save();
    await audit(req.user, 'message_request.resent_after_scope_change', 'Conversation', c._id, 'direct');
    return res.status(201).json(c);
  }
  if (c) {
    c.requestState = direct ? 'accepted' : 'pending'; c.requestSender = req.user._id; c.recipientCanResubmit = false;
    c.relationshipSnapshot = await relationshipSnapshot(req.user, recipient); c.messages.push({ sender: req.user._id, body }); c.lastMessageAt = new Date(); await c.save();
  } else {
    c = await Conversation.create({ participants: [req.user._id, recipient._id], requestState: direct ? 'accepted' : 'pending', requestSender: req.user._id, relationshipSnapshot: await relationshipSnapshot(req.user, recipient), messages: [{ sender: req.user._id, body }], lastMessageAt: new Date() });
  }
  await audit(req.user, direct ? 'conversation.started' : 'message_request.sent', 'Conversation', c._id, 'direct');
  await notifyUser(recipient._id, { type: direct ? 'message' : 'message-request', conversationId: String(c._id), from: req.user.name, preview: direct ? 'New message' : 'New message request' }).catch(() => {});
  res.status(201).json(c);
});

router.post('/conversations/:id/decision', async (req, res) => {
  const c = await Conversation.findById(req.params.id);
  if (!c || !c.participants.some(x => x.equals(req.user._id))) return res.status(404).json({ message: 'Conversation not found.' });
  if (c.requestState !== 'pending' || c.requestSender?.equals(req.user._id)) return res.status(400).json({ message: 'There is no request for you to decide.' });
  if (!['accepted', 'declined'].includes(req.body.decision)) return res.status(400).json({ message: 'Invalid decision.' });
  c.requestState = req.body.decision;
  if (c.requestState === 'accepted') { const sender = await User.findById(c.requestSender); const recipient = await User.findById(c.participants.find(x => !x.equals(c.requestSender))); if (sender && recipient) c.relationshipSnapshot = await relationshipSnapshot(sender, recipient); }
  c.recipientCanResubmit = req.body.decision === 'declined' && req.body.allowResubmit === true;
  await c.save();
  await audit(req.user, `message_request.${c.requestState}`, 'Conversation', c._id, 'direct');
  await notifyUser(c.requestSender, { type: `message-request-${c.requestState}`, conversationId: String(c._id), from: req.user.name, preview: c.requestState === 'accepted' ? 'Your message request was accepted' : 'Your message request was declined' }).catch(() => {});
  res.json(c);
});

router.post('/conversations/:id/block', async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation || !conversation.participants.some(p => id(p) === id(req.user._id))) return res.status(404).json({ message: 'Conversation not found.' });
  if (!conversation.blockedBy.some(p => id(p) === id(req.user._id))) conversation.blockedBy.push(req.user._id);
  await conversation.save(); await audit(req.user, 'conversation.user_blocked', 'Conversation', conversation._id, 'direct');
  res.json({ message: 'This conversation is blocked. Messages and requests are disabled.' });
});
router.post('/conversations/:id/unblock', async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation || !conversation.participants.some(p => id(p) === id(req.user._id))) return res.status(404).json({ message: 'Conversation not found.' });
  conversation.blockedBy = conversation.blockedBy.filter(p => id(p) !== id(req.user._id));
  await conversation.save(); await audit(req.user, 'conversation.user_unblocked', 'Conversation', conversation._id, 'direct');
  res.json({ message: conversation.blockedBy.length ? 'Your block was removed; the other participant still has a block active.' : 'Conversation unblocked.' });
});

// Technical Admin account recovery is intentionally isolated from institutional role assignment.
router.get('/technical/users', async (req, res) => {
  if (!hasScopedPermission(req.user, 'system:technical', { scope: 'university' }) || !hasScopedPermission(req.user, 'accounts:recover', { scope: 'university' })) return res.status(403).json({ message: 'Technical account-recovery permission is required.' });
  const q = String(req.query.q || '').trim().slice(0, 80);
  const filter = {};
  if (q) { const safeQ = escaped(q); filter.$or = [{ name: { $regex: safeQ, $options: 'i' } }, { email: { $regex: safeQ, $options: 'i' } }]; }
  res.json(await User.find(filter).select('name email role campus department status mfa').limit(100));
});
router.patch('/technical/users/:id/recovery', async (req, res) => {
  if (!hasScopedPermission(req.user, 'system:technical', { scope: 'university' }) || !hasScopedPermission(req.user, 'accounts:recover', { scope: 'university' })) return res.status(403).json({ message: 'Technical account-recovery permission is required.' });
  const target = await User.findById(req.params.id).select('+passwordHash');
  if (!target) return res.status(404).json({ message: 'Account not found.' });
  if (target._id.equals(req.user._id)) return res.status(400).json({ message: 'Use the account security workflow to recover your own account.' });
  const { password, status } = req.body;
  if ((password === undefined || String(password).length < 8) && status === undefined) return res.status(400).json({ message: 'Provide a new password (at least 8 characters) or a valid account status.' });
  if (password !== undefined) {
    if (String(password).length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    target.passwordHash = await bcrypt.hash(String(password), 12);
  }
  if (status !== undefined) {
    if (!['active', 'suspended', 'deactivated'].includes(status)) return res.status(400).json({ message: 'Invalid account status.' });
    target.status = status;
  }
  target.securityVersion += 1; await target.save();
  await revalidateGroupsForUser(target, req.user, 'technical-account-status-change');
  await audit(req.user, 'technical.account.recovered', 'User', target._id, 'technical', { passwordReset: password !== undefined, status: target.status });
  res.json({ message: 'Account recovery action completed.', user: safeUser(target) });
});

// A lost or compromised second factor is recovered by a Technical Admin: the reset is audited and it bumps
// securityVersion, so every outstanding session for that account ends immediately and a fresh sign-in is required.
router.post('/technical/users/:id/mfa-reset', async (req, res) => {
  if (!hasScopedPermission(req.user, 'system:technical', { scope: 'university' }) || !hasScopedPermission(req.user, 'accounts:recover', { scope: 'university' })) return res.status(403).json({ message: 'Technical account-recovery permission is required.' });
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ message: 'Account not found.' });
  if (target._id.equals(req.user._id)) return res.status(400).json({ message: 'Use the account security workflow to manage your own second factor.' });
  if (!target.mfa?.enabled) return res.status(400).json({ message: 'This account does not have two-factor authentication enabled.' });
  target.mfa = { enabled: false, secret: '', pendingSecret: '', recoveryCodes: [], lastStep: -1, attempts: 0 };
  target.securityVersion += 1;
  await target.save();
  await audit(req.user, 'technical.mfa.reset', 'User', target._id, 'technical');
  res.json({ message: `${target.name} must sign in again and set up a new second factor.`, user: safeUser(target) });
});

// Institutional role assignment controls are intentionally separate from technical administration.
router.get('/management/users', async (req, res) => {
  if (!canManageInstitutionalUsers(req.user)) return res.status(403).json({ message: 'Institutional user-management permission is not assigned to your role and scope.' });
  const q = String(req.query.q || '').trim().slice(0, 80);
  const filter = managementFilter(req.user);
  if (!filter) return res.status(403).json({ message: 'No valid user-management scope is assigned to this account.' });
  if (q) { const safeQ = escaped(q); filter.$and = [{ $or: [{ name: { $regex: safeQ, $options: 'i' } }, { email: { $regex: safeQ, $options: 'i' } }, { department: { $regex: safeQ, $options: 'i' } }, { role: { $regex: safeQ, $options: 'i' } }] }]; }
  const rows = await User.find(filter).select('name email role campus department assignments status createdAt lastSeen').sort({ createdAt: -1 }).limit(250);
  res.json(rows);
});

router.post('/management/users', async (req, res) => {
  if (!canManageInstitutionalUsers(req.user)) return res.status(403).json({ message: 'Institutional user-management permission is not assigned to your role and scope.' });
  const { name, email, password, role, campus, department } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  const target = { role, campus: String(campus || '').trim(), department: String(department || '').trim() };
  if (!cleanName || !/^\S+@comsats\.edu\.pk$/i.test(cleanEmail) || String(password || '').length < 8) return res.status(400).json({ message: 'Enter a name, a @comsats.edu.pk email, and a password of at least 8 characters.' });
  if (!ROLES.includes(role) || !canAssignRole(req.user, role, target)) return res.status(403).json({ message: 'You cannot assign that role in this organizational scope.' });
  if (await User.exists({ email: cleanEmail })) return res.status(409).json({ message: 'An account with this email already exists.' });
  const user = await User.create({ name: cleanName, email: cleanEmail, passwordHash: await bcrypt.hash(password, 12), role, campus: target.campus, department: target.department, status: 'active', assignments: [{ role, campus: target.campus, department: target.department, scope: role === 'Rector' ? 'university' : role === 'Campus Incharge' ? 'campus' : role === 'Teacher' ? 'class' : 'department', permissions: [], active: true, assignedBy: req.user._id }] });
  await audit(req.user, 'user.created', 'User', user._id, target.department ? 'department' : target.campus ? 'campus' : 'university', { role, campus: target.campus, department: target.department });
  await syncDefaultMemberships(user);
  res.status(201).json({ message: 'Account created.', user: safeUser(user) });
});

router.patch('/management/users/:id', async (req, res) => {
  const target = await User.findById(req.params.id).select('+passwordHash');
  if (!target) return res.status(404).json({ message: 'User not found.' });
  if (target._id.equals(req.user._id)) return res.status(400).json({ message: 'You cannot edit your own institutional role or account from this screen.' });
  if (!canManageTargetScope(req.user, target)) return res.status(403).json({ message: 'This account is outside your assigned management scope.' });
  const { name, role, campus, department, status, password } = req.body;
  const proposedTarget = { role: role ?? target.role, campus: String(campus ?? target.campus ?? '').trim(), department: String(department ?? target.department ?? '').trim() };
  if ((role !== undefined || campus !== undefined || department !== undefined) && !canManageInstitutionalUsers(req.user, proposedTarget)) return res.status(403).json({ message: 'The requested role or organizational scope is outside your authority.' });
  if (role !== undefined && role !== target.role && !canAssignRole(req.user, role, proposedTarget)) return res.status(403).json({ message: 'You cannot assign that role in this scope.' });
  if (status !== undefined && !['active', 'suspended', 'deactivated'].includes(status)) return res.status(400).json({ message: 'Invalid account status.' });
  const previousRole = target.role, previousCampus = target.campus || '', previousDepartment = target.department || '', previousStatus = target.status;
  const nextRole = role ?? previousRole;
  const nextCampus = campus === undefined ? previousCampus : String(campus).trim();
  const nextDepartment = department === undefined ? previousDepartment : String(department).trim();
  const roleChanged = nextRole !== previousRole;
  const campusChanged = nextCampus !== previousCampus;
  const departmentChanged = nextDepartment !== previousDepartment;
  const statusChanged = status !== undefined && status !== previousStatus;
  const securitySensitive = roleChanged || campusChanged || departmentChanged || statusChanged;
  if (name !== undefined) target.name = String(name).trim().slice(0, 120);
  if (roleChanged || campusChanged || departmentChanged) {
    target.assignments.forEach(a => {
      if (a.active !== false && a.role === previousRole && (a.campus || '') === previousCampus && (a.department || '') === previousDepartment) { a.active = false; a.revokedAt = new Date(); }
    });
    target.role = nextRole; target.campus = nextCampus; target.department = nextDepartment;
    target.assignments.push({ role: target.role, campus: target.campus, department: target.department, scope: target.role === 'Rector' || target.role === 'Technical Admin' ? 'university' : target.role === 'Campus Incharge' ? 'campus' : target.role === 'Teacher' ? 'class' : target.role === 'Employee account' ? 'department' : 'department', permissions: [], active: true, assignedBy: req.user._id });
  }
  if (statusChanged) target.status = status;
  if (password !== undefined && String(password).length) {
    if (String(password).length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    target.passwordHash = await bcrypt.hash(password, 12);
    target.securityVersion += 1;
  }
  if (securitySensitive) target.securityVersion += 1;
  await target.save();
  await revalidateGroupsForUser(target, req.user, 'user-role-or-scope-change');
  await syncDefaultMemberships(target);
  await audit(req.user, 'user.updated', 'User', target._id, target.department ? 'department' : target.campus ? 'campus' : 'university', { changedFields: Object.keys(req.body).filter(k => ['name', 'role', 'campus', 'department', 'status', 'password'].includes(k)), role: target.role, status: target.status });
  res.json({ message: 'Account updated.', user: safeUser(target) });
});

const ALLOWED_ASSIGNMENT_PERMISSIONS = new Set([
  'users:manage', 'roles:assign',
  'groups:manage', 'groups:members:manage', 'groups:posting:manage', 'groups:delegations:manage',
  'groups:create:university', 'groups:create:campus', 'groups:create:department', 'groups:create:class', 'groups:create:functional',
  // Authority to send broadcasts to official groups in the assignment's scope (see docs/AUTHORIZATION-MATRIX.md).
  'broadcast:send'
]);
router.post('/management/users/:id/assignments', async (req, res) => {
  const targetUser = await User.findById(req.params.id);
  if (!targetUser) return res.status(404).json({ message: 'User not found.' });
  if (targetUser.role === 'Technical Admin') return res.status(403).json({ message: 'Technical Admin accounts cannot receive institutional role assignments.' });
  const { role, scope, campus = '', department = '', permissions = [] } = req.body;
  const target = { role, campus: String(campus || '').trim(), department: String(department || '').trim() };
  if (!ROLES.includes(role) || !['university', 'campus', 'department', 'class', 'functional'].includes(scope) || !Array.isArray(permissions) || permissions.some(p => !ALLOWED_ASSIGNMENT_PERMISSIONS.has(p))) return res.status(400).json({ message: 'Invalid role, scope, or permission list.' });
  const allowedScopesByRole = {
    'Rector': ['university'], 'Campus Incharge': ['campus'], 'HOD': ['department'],
    'Department Coordinator': ['department'], 'Teacher': ['department', 'class'],
    'Student': ['department', 'class'], 'Employee account': ['department', 'functional'], 'Technical Admin': ['university']
  };
  if (!allowedScopesByRole[role]?.includes(scope)) return res.status(400).json({ message: 'This role cannot be assigned at the requested scope.' });
  if (!canAssignRole(req.user, role, target)) return res.status(403).json({ message: 'You cannot assign this role in the requested scope.' });
  if (!hasScopedPermission(req.user, 'roles:assign', { scope, campus: target.campus, department: target.department })) return res.status(403).json({ message: 'You cannot create an assignment outside your explicit role-assignment scope.' });
  if (permissions.some(permission => !hasScopedPermission(req.user, permission, { scope, campus: target.campus, department: target.department }))) return res.status(403).json({ message: 'You cannot delegate permissions you do not hold in this scope.' });
  const assignment = { role, scope, campus: target.campus, department: target.department, permissions: [...new Set(permissions)], active: true, assignedBy: req.user._id, assignedAt: new Date() };
  targetUser.assignments.push(assignment); targetUser.securityVersion += 1; await targetUser.save();
  await revalidateGroupsForUser(targetUser, req.user, 'assignment-created');
  await syncDefaultMemberships(targetUser);
  await audit(req.user, 'user.assignment.created', 'User', targetUser._id, scope, { assignedRole: role, campus: target.campus, department: target.department, permissions: assignment.permissions });
  res.status(201).json({ message: 'Scoped assignment created.', user: safeUser(targetUser), assignment: targetUser.assignments.at(-1) });
});
router.delete('/management/users/:id/assignments/:assignmentId', async (req, res) => {
  const targetUser = await User.findById(req.params.id);
  if (!targetUser) return res.status(404).json({ message: 'User not found.' });
  if (targetUser.role === 'Technical Admin') return res.status(403).json({ message: 'Technical Admin assignments are managed only by the technical bootstrap/security workflow.' });
  const assignment = targetUser.assignments.id(req.params.assignmentId);
  if (!assignment || assignment.active === false) return res.status(404).json({ message: 'Active assignment not found.' });
  if (assignment.role === targetUser.role && assignment.campus === targetUser.campus && assignment.department === targetUser.department) return res.status(400).json({ message: 'Change the primary role or organizational assignment through the user-management workflow instead.' });
  if (!canAssignRole(req.user, assignment.role, { campus: assignment.campus, department: assignment.department }) || !hasScopedPermission(req.user, 'roles:assign', { scope: assignment.scope, campus: assignment.campus, department: assignment.department })) return res.status(403).json({ message: 'You do not have permission to revoke this assignment in its scope.' });
  assignment.active = false; assignment.revokedAt = new Date(); targetUser.securityVersion += 1; await targetUser.save();
  await revalidateGroupsForUser(targetUser, req.user, 'assignment-revoked');
  await audit(req.user, 'user.assignment.revoked', 'User', targetUser._id, assignment.scope, { assignmentId: String(assignment._id), assignedRole: assignment.role });
  res.json({ message: 'Scoped assignment revoked.', user: safeUser(targetUser) });
});

router.patch('/groups/:id/owner', async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  const authorizationGroup = group.toObject(); authorizationGroup.archived = false;
  const currentOwner = await User.findById(group.owner);
  const currentOwnerEligible = !!currentOwner && currentOwner.status === 'active' && inGroupScope(currentOwner, group) && canOwnGroup(currentOwner, group);
  const actingOwner = id(group.owner) === id(req.user._id);
  if (!(actingOwner && canManageGroup(req.user, authorizationGroup, 'groups:manage')) && !(!currentOwnerEligible && canManageGroup(req.user, authorizationGroup, 'groups:manage'))) return res.status(403).json({ message: 'Ownership transfer requires the eligible owner or a scoped manager when the owner is no longer eligible.' });
  const candidate = await User.findById(req.body.newOwnerId);
  if (!candidate || candidate.status !== 'active' || !memberOf(group, candidate._id) || !inGroupScope(candidate, group) || !canOwnGroup(candidate, authorizationGroup)) return res.status(400).json({ message: 'The new owner must be an active, eligible member with authority for this group scope.' });
  const previousOwner = group.owner; group.owner = candidate._id; group.managers = group.managers.filter(m => id(m) !== id(candidate._id) && id(m) !== id(previousOwner)); group.requiresOwnerIntervention = false;
  for (const d of group.delegations) if (id(d.grantedBy) === id(previousOwner) && d.active !== false) { d.active = false; d.revokedAt = new Date(); }
  await group.save(); await audit(req.user, 'group.owner.transferred', 'Group', group._id, group.scope, { previousOwner: id(previousOwner), newOwner: id(candidate._id) });
  res.json({ message: 'Group ownership transferred.', group: await Group.findById(group._id).select('-messages').populate('owner', 'name role') });
});

router.post('/groups/:id/delegations', async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group || group.archived) return res.status(404).json({ message: 'Active group not found.' });
  if (!canManageGroup(req.user, group, 'groups:delegations:manage')) return res.status(403).json({ message: 'You do not have delegation-management permission for this group.' });
  const delegate = await User.findById(req.body.userId);
  const capabilities = req.body.capabilities;
  const allowed = ['groups:manage', 'groups:members:manage', 'groups:posting:manage', 'groups:delegations:manage'];
  if (!delegate || delegate.status !== 'active' || !memberOf(group, delegate._id) || !inGroupScope(delegate, group)) return res.status(400).json({ message: 'Delegate must be an active, eligible group member.' });
  if (id(delegate._id) === id(req.user._id) || !Array.isArray(capabilities) || !capabilities.length || capabilities.some(c => !allowed.includes(c))) return res.status(400).json({ message: 'Choose one or more valid capabilities for another member.' });
  if (capabilities.some(capability => !canManageGroup(req.user, group, capability))) return res.status(403).json({ message: 'You cannot delegate a capability you do not hold for this group.' });
  const existing = group.delegations.find(d => id(d.user) === id(delegate._id) && id(d.grantedBy) === id(req.user._id) && d.active !== false);
  if (existing) { existing.capabilities = [...new Set([...existing.capabilities, ...capabilities])]; existing.grantedBy = req.user._id; }
  else group.delegations.push({ user: delegate._id, grantedBy: req.user._id, capabilities: [...new Set(capabilities)], scope: group.scope, active: true });
  if (!group.managers.some(m => id(m) === id(delegate._id))) group.managers.push(delegate._id);
  await group.save(); await audit(req.user, 'group.delegation.created', 'Group', group._id, group.scope, { delegateId: id(delegate._id), capabilities: [...new Set(capabilities)] });
  res.status(201).json({ message: 'Scoped group delegation saved.' });
});
router.delete('/groups/:id/delegations/:delegationId', async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  if (!canManageGroup(req.user, group, 'groups:delegations:manage')) return res.status(403).json({ message: 'You do not have delegation-management permission for this group.' });
  const delegation = group.delegations.id(req.params.delegationId);
  if (!delegation || delegation.active === false) return res.status(404).json({ message: 'Active delegation not found.' });
  delegation.active = false; delegation.revokedAt = new Date();
  if (!group.delegations.some(d => d.active !== false && id(d.user) === id(delegation.user))) group.managers = group.managers.filter(m => id(m) !== id(delegation.user));
  await group.save(); await audit(req.user, 'group.delegation.revoked', 'Group', group._id, group.scope, { delegateId: id(delegation.user), capabilities: delegation.capabilities });
  res.json({ message: 'Group delegation revoked.' });
});

router.patch('/groups/:id/lifecycle', async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  const action = req.body.action;
  if (!['archive', 'restore'].includes(action)) return res.status(400).json({ message: 'Action must be archive or restore.' });
  const authCandidate = group.toObject(); authCandidate.archived = false;
  if (!canManageGroup(req.user, authCandidate, 'groups:manage')) return res.status(403).json({ message: 'You cannot change this group lifecycle.' });
  if (action === 'archive') {
    if (group.archived) return res.json({ message: 'Group is already archived.' });
    group.archived = true; group.archivedAt = new Date(); group.managers = []; group.publishers = []; group.delegations.forEach(d => { d.active = false; d.revokedAt = new Date(); });
    await group.save(); await audit(req.user, 'group.archived', 'Group', group._id, group.scope);
    return res.json({ message: 'Group archived. New messages are disabled; authorized history is preserved.' });
  }
  if (!group.archived) return res.json({ message: 'Group is already active.' });
  const owner = await User.findById(group.owner);
  if (!owner || owner.status !== 'active' || !inGroupScope(owner, group) || !canOwnGroup(owner, group) || group.requiresOwnerIntervention) return res.status(409).json({ message: 'The owner is no longer eligible. Transfer ownership to an eligible member before restoring this group.' });
  const candidates = await User.find({ _id: { $in: group.members }, status: 'active' });
  const eligibleIds = new Set(candidates.filter(u => inGroupScope(u, group)).map(u => id(u._id)));
  group.members = group.members.filter(m => eligibleIds.has(id(m)));
  group.managers = group.managers.filter(m => eligibleIds.has(id(m)));
  group.publishers = group.publishers.filter(m => eligibleIds.has(id(m)));
  group.archived = false; group.archivedAt = undefined; group.requiresOwnerIntervention = false;
  await group.save(); await audit(req.user, 'group.restored', 'Group', group._id, group.scope, { activeMemberCount: group.members.length });
  res.json({ message: 'Group restored after scope and membership revalidation.' });
});

router.get('/management/groups', async (req, res) => {
  const rows = await Group.find({ archived: false }).select('-messages').populate('owner', 'name role').populate('members', 'name email role campus department status').populate('managers', 'name role').populate('joinRequests.user', 'name role');
  res.json(rows.filter(g => canManageGroup(req.user, g, 'groups:manage') || canManageGroup(req.user, g, 'groups:members:manage')));
});

router.patch('/management/groups/:id/members', async (req, res) => {
  const { userId, action } = req.body;
  if (!userId || !['add', 'remove'].includes(action)) return res.status(400).json({ message: 'Provide a userId and add/remove action.' });
  const group = await Group.findById(req.params.id);
  const target = await User.findById(userId);
  if (!group || group.archived) return res.status(404).json({ message: 'Group not found.' });
  if (!target || target.status !== 'active') return res.status(404).json({ message: 'Active user not found.' });
  if (!canManageGroup(req.user, group, 'groups:members:manage')) return res.status(403).json({ message: 'You do not have member-management permission for this group.' });
  if (!inGroupScope(target, group)) return res.status(403).json({ message: 'The user is not eligible for this group scope.' });
  const already = memberOf(group, target._id);
  if (action === 'add' && !already && group.scope === 'personal') {
    // Informal groups never enroll people without consent: the invitee must accept before they can receive anything.
    if (id(target._id) === id(req.user._id)) return res.status(400).json({ message: 'You are already the owner.' });
    const existing = group.invitations.find(i => id(i.user) === id(target._id) && i.status === 'pending');
    if (!existing) group.invitations.push({ user: target._id, invitedBy: req.user._id, status: 'pending' });
    await group.save();
    await audit(req.user, 'group.invitation.sent', 'Group', group._id, group.scope, { userId: id(target._id) });
    await notifyUser(target._id, { type: 'group-invitation', groupId: String(group._id), preview: `${req.user.name} invited you to ${group.name}` });
    return res.json({ message: 'Invitation sent. They will be added once they accept.', group: await Group.findById(group._id).select('-messages').populate('owner', 'name role').populate('members', 'name email role campus department status') });
  }
  if (action === 'add' && !already) {
    group.removedUsers = (group.removedUsers || []).filter(m => id(m) !== id(target._id));
    group.members.push(target._id);
    group.membershipHistory.push({ user: target._id, joinedAt: new Date(), leftAt: null, reason: 'manager-added' });
  }
  if (action === 'remove' && already) {
    if (id(group.owner) === id(target._id)) return res.status(400).json({ message: 'Transfer ownership before removing the owner.' });
    group.members = group.members.filter(m => id(m) !== id(target._id));
    group.managers = group.managers.filter(m => id(m) !== id(target._id));
    group.publishers = group.publishers.filter(m => id(m) !== id(target._id));
    for (const delegation of group.delegations) if (id(delegation.user) === id(target._id) && delegation.active !== false) { delegation.active = false; delegation.revokedAt = new Date(); }
    const period = [...group.membershipHistory].reverse().find(p => id(p.user) === id(target._id) && !p.leftAt);
    if (period) period.leftAt = new Date();
    group.joinRequests = group.joinRequests.filter(r => id(r.user) !== id(target._id));
    if (group.autoEnroll && !(group.removedUsers || []).some(m => id(m) === id(target._id))) group.removedUsers.push(target._id);
  }
  await group.save();
  await audit(req.user, `group.member.${action}`, 'Group', group._id, group.scope, { groupName: group.name, userId: id(target._id) });
  await notifyUser(target._id, { type: 'group-membership', groupId: String(group._id), preview: action === 'add' ? `You were added to ${group.name}` : `Your membership in ${group.name} changed` });
  const updated = await Group.findById(group._id).select('-messages').populate('owner', 'name role').populate('members', 'name email role campus department status');
  res.json({ message: action === 'add' ? 'Member added.' : 'Member removed.', group: updated });
});

router.get('/admin/groups', async (req, res) => {
  const rows = await Group.find({ archived: false }).select('-messages').populate('owner', 'name role').populate('publishers', 'name role');
  res.json(rows.filter(g => canManageGroup(req.user, g, 'groups:posting:manage')));
});
router.patch('/admin/groups/:id/permissions', async (req, res) => {
  const { postingRoles } = req.body;
  if (!Array.isArray(postingRoles) || postingRoles.some(role => !ROLES.includes(role))) return res.status(400).json({ message: 'Choose valid roles for group posting.' });
  const group = await Group.findById(req.params.id);
  if (!group || group.archived) return res.status(404).json({ message: 'Group not found.' });
  if (!canManageGroup(req.user, group, 'groups:posting:manage')) return res.status(403).json({ message: 'You do not have permission to change posting rules for this group.' });
  group.postingRoles = [...new Set(postingRoles)];
  group.postingPolicy = group.postingRoles.length === ROLES.length ? 'members' : 'publishers';
  await group.save();
  await audit(req.user, 'group.posting_permissions.updated', 'Group', group._id, group.scope, { postingRoles: group.postingRoles, groupName: group.name });
  await notifyUsers(group.members, { type: 'group-policy', groupId: String(group._id), preview: `Posting permissions changed for ${group.name}` });
  res.json({ message: 'Group posting permissions saved.', group: { _id: group._id, name: group.name, postingRoles: group.postingRoles, postingPolicy: group.postingPolicy } });
});

router.get('/groups', async (req, res) => {
  // Membership in the default Everyone/campus/department groups is normally established when the account is created or
  // its scope changes; this call is a safety net and honours manual removals.
  await syncDefaultMemberships(req.user);
  const rows = await Group.find({ archived: false, $or: [{ visibility: { $in: ['open', 'approval'] } }, { members: req.user._id }, { owner: req.user._id }] }).select('-messages').populate('owner', 'name role');
  const visible = rows.filter(g => memberOf(g, req.user._id) || id(g.owner) === id(req.user._id) || (g.visibility !== 'private' && inGroupScope(req.user, g)));
  // Groups are audiences, never rooms: expose a member count, not the roster, to people who cannot manage membership.
  res.json(visible.map(g => {
    const o = g.toObject();
    const manage = canManageGroup(req.user, g, 'groups:members:manage');
    const pending = (g.joinRequests || []).some(r => id(r.user) === id(req.user._id) && r.status === 'pending');
    const invited = (g.invitations || []).some(i => id(i.user) === id(req.user._id) && i.status === 'pending');
    const senderCount = (g.publishers || []).length;
    delete o.joinRequests; delete o.invitations; delete o.removedUsers; delete o.delegations; delete o.membershipHistory;
    if (!manage) { delete o.members; delete o.managers; delete o.publishers; }
    return { ...o, memberCount: g.members.length, senderCount, isMember: memberOf(g, req.user._id), isOwner: id(g.owner) === id(req.user._id), canManageMembers: manage, canBroadcast: canBroadcastToGroup(req.user, g), joinRequestPending: pending, invitationPending: invited, official: g.scope !== 'personal' };
  }));
});

router.get('/groups/invitations', async (req, res) => {
  const found = await Group.find({ archived: false, 'invitations.user': req.user._id }).select('name description scope invitations owner').populate('owner', 'name role');
  const groups = found.filter(g => g.invitations.some(i => id(i.user) === id(req.user._id) && i.status === 'pending'));
  res.json(groups.map(g => ({ groupId: g._id, name: g.name, description: g.description, owner: g.owner, invitedAt: g.invitations.find(i => id(i.user) === id(req.user._id) && i.status === 'pending')?.createdAt })));
});
router.post('/groups/:id/invitations/respond', async (req, res) => {
  const decision = req.body?.decision;
  if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ message: 'Decision must be accept or decline.' });
  const group = await Group.findById(req.params.id).select('-messages');
  const invitation = group && !group.archived ? group.invitations.find(i => id(i.user) === id(req.user._id) && i.status === 'pending') : null;
  if (!invitation) return res.status(404).json({ message: 'Invitation not found.' });
  invitation.status = decision === 'accept' ? 'accepted' : 'declined'; invitation.decidedAt = new Date();
  if (decision === 'accept' && !memberOf(group, req.user._id)) {
    group.members.push(req.user._id);
    group.membershipHistory.push({ user: req.user._id, joinedAt: new Date(), reason: 'accepted-invitation' });
  }
  await group.save();
  await audit(req.user, `group.invitation.${invitation.status}`, 'Group', group._id, group.scope);
  await notifyUser(group.owner, { type: 'group-membership', groupId: String(group._id), preview: `An invitation to ${group.name} was ${invitation.status}` });
  res.json({ message: decision === 'accept' ? 'You joined the group.' : 'Invitation declined.' });
});
router.post('/groups/:id/leave', async (req, res) => {
  const group = await Group.findById(req.params.id).select('-messages');
  if (!group || group.archived || !memberOf(group, req.user._id)) return res.status(404).json({ message: 'Group not found.' });
  if (id(group.owner) === id(req.user._id)) return res.status(400).json({ message: 'Transfer ownership before leaving the group.' });
  group.members = group.members.filter(m => id(m) !== id(req.user._id));
  group.managers = group.managers.filter(m => id(m) !== id(req.user._id));
  group.publishers = group.publishers.filter(m => id(m) !== id(req.user._id));
  if (group.autoEnroll) group.removedUsers.push(req.user._id);
  const period = [...group.membershipHistory].reverse().find(p => id(p.user) === id(req.user._id) && !p.leftAt);
  if (period) period.leftAt = new Date();
  await group.save();
  await audit(req.user, 'group.member.left', 'Group', group._id, group.scope);
  res.json({ message: 'You left the group.' });
});
// ---- Who can send to a group: managed by the group's OWNER (informal and official groups) ----
const SENDER_LIMIT = 50;
async function loadOwnedGroup(req, res) {
  const group = await Group.findById(req.params.id).select('-messages');
  if (!group || group.archived) { res.status(404).json({ message: 'Group not found.' }); return null; }
  if (id(group.owner) !== id(req.user._id)) { res.status(403).json({ message: 'Only the group owner can choose who can send messages to this group.' }); return null; }
  return group;
}
router.get('/groups/:id/senders', async (req, res) => {
  const group = await loadOwnedGroup(req, res); if (!group) return;
  const senderIds = new Set((group.publishers || []).map(id));
  const members = await User.find({ _id: { $in: group.members }, status: 'active' }).select('name role campus department status assignments');
  res.json({
    official: group.scope !== 'personal', postingPolicy: group.postingPolicy, postingRoles: group.scope !== 'personal' ? group.postingRoles : [], limit: SENDER_LIMIT,
    members: members.filter(m => id(m._id) !== id(group.owner)).map(m => ({ _id: m._id, name: m.name, role: m.role, canSend: senderIds.has(id(m._id)), eligible: m.role !== 'Technical Admin' && (group.scope === 'personal' || isEligibleForGroup(m, group)) }))
  });
});
router.patch('/groups/:id/senders', async (req, res) => {
  const group = await loadOwnedGroup(req, res); if (!group) return;
  const { userId, canSend } = req.body || {};
  if (!userId || typeof canSend !== 'boolean') return res.status(400).json({ message: 'Provide a userId and canSend true/false.' });
  if (id(userId) === id(group.owner)) return res.status(400).json({ message: 'The owner is not affected by this list. Owners send under their own role and permissions.' });
  const target = await User.findById(userId);
  if (!target || target.status !== 'active' || !memberOf(group, target._id)) return res.status(400).json({ message: 'Only current members can be chosen as senders.' });
  const official = group.scope !== 'personal';
  if (canSend) {
    // Guardrails: an owner cannot widen institutional rules. Technical Admin is never a sender, and for official groups the member must be eligible for the group's scope.
    if (target.role === 'Technical Admin') return res.status(403).json({ message: 'Technical Admin accounts cannot be chosen as senders.' });
    if (official && !isEligibleForGroup(target, group)) return res.status(403).json({ message: 'This person is not eligible to send within the group\'s institutional scope.' });
    if (!official && group.postingPolicy === 'members') return res.status(400).json({ message: 'Every member can already send. Change the posting policy first if you want to choose senders.' });
    if (!(group.publishers || []).some(p => id(p) === id(target._id)) && (group.publishers || []).length >= SENDER_LIMIT) return res.status(400).json({ message: `You can choose at most ${SENDER_LIMIT} senders.` });
    if (!(group.publishers || []).some(p => id(p) === id(target._id))) group.publishers.push(target._id);
    if (!official && group.postingPolicy === 'owner') group.postingPolicy = 'publishers';   // otherwise the grant would have no effect
  } else {
    group.publishers = (group.publishers || []).filter(p => id(p) !== id(target._id));
  }
  await group.save();
  await audit(req.user, canSend ? 'group.sender.granted' : 'group.sender.revoked', 'Group', group._id, group.scope, { groupName: group.name, userId: id(target._id) });
  await notifyUser(target._id, { type: 'group-membership', groupId: String(group._id), preview: canSend ? `You can now send messages to ${group.name}` : `Your permission to send to ${group.name} was removed` });
  res.json({ message: canSend ? `${target.name} can now send to this group.` : `${target.name} can no longer send to this group.`, postingPolicy: group.postingPolicy, senderCount: group.publishers.length });
});
// Informal-group settings. Official groups change posting rules only through /admin/groups/:id/permissions.
router.patch('/groups/:id/settings', async (req, res) => {
  const group = await Group.findById(req.params.id).select('-messages');
  if (!group || group.archived) return res.status(404).json({ message: 'Group not found.' });
  if (group.scope !== 'personal') return res.status(403).json({ message: 'Official group rules are managed through institutional permissions.' });
  if (id(group.owner) !== id(req.user._id)) return res.status(403).json({ message: 'Only the group owner can change these settings.' });
  const { visibility, postingPolicy, description } = req.body || {};
  if (visibility !== undefined) { if (!['private', 'approval', 'open'].includes(visibility)) return res.status(400).json({ message: 'Invalid visibility.' }); group.visibility = visibility; }
  if (postingPolicy !== undefined) { if (!['owner', 'publishers', 'members'].includes(postingPolicy)) return res.status(400).json({ message: 'Invalid posting policy.' }); group.postingPolicy = postingPolicy; }
  if (description !== undefined) group.description = String(description).slice(0, 2000);
  await group.save();
  await audit(req.user, 'group.settings.updated', 'Group', group._id, group.scope, { visibility: group.visibility, postingPolicy: group.postingPolicy });
  res.json({ message: 'Group settings saved.', group: { _id: group._id, visibility: group.visibility, postingPolicy: group.postingPolicy, description: group.description } });
});
const OFFICIAL_SCOPES = ['university', 'campus', 'department', 'class', 'functional'];
const ANY = '\u0000any';   // probe value used only to ask the policy "could this user create a group for ANY campus/department?"
const escapeRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What kinds of groups may THIS user create? Derived from the central policy (canCreateGroup) so the client never
 * duplicates authorization rules. Informal groups are always allowed for active accounts; official ones depend on
 * scoped `groups:create:<scope>` permissions on the user's assignments.
 */
router.get('/groups/creatable', async (req, res) => {
  const pairs = [{ campus: req.user.campus || '', department: req.user.department || '' }, ...(req.user.assignments || []).filter(x => x.active !== false).map(x => ({ campus: x.campus || '', department: x.department || '' }))];
  const campuses = [...new Set(pairs.map(p => p.campus).filter(Boolean))];
  const official = [];
  for (const scope of OFFICIAL_SCOPES) {
    if (scope === 'university') { if (canCreateGroup(req.user, 'university', {})) official.push({ scope, anyCampus: false, campuses: [] }); continue; }
    if (canCreateGroup(req.user, scope, { campus: ANY, department: ANY })) { official.push({ scope, anyCampus: true, campuses: [] }); continue; }
    const entries = [];
    for (const campus of campuses) {
      if (scope === 'campus') { if (canCreateGroup(req.user, 'campus', { campus })) entries.push({ campus, anyDepartment: false, departments: [] }); continue; }
      if (canCreateGroup(req.user, scope, { campus, department: ANY })) { entries.push({ campus, anyDepartment: true, departments: [] }); continue; }
      const departments = [...new Set(pairs.filter(p => p.campus === campus && p.department).map(p => p.department))].filter(department => canCreateGroup(req.user, scope, { campus, department }));
      if (departments.length) entries.push({ campus, anyDepartment: false, departments });
    }
    if (entries.length) official.push({ scope, anyCampus: false, campuses: entries });
  }
  res.json({ informal: true, official, defaults: { campus: req.user.campus || '', department: req.user.department || '' }, eligibleRoles: ROLES.filter(r => r !== 'Technical Admin') });
});

router.post('/groups', async (req, res) => {
  const { name, description = '', type = 'discussion', scope = 'personal', visibility = 'private', allowMemberDirectMessages = false } = req.body;
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.status(400).json({ message: 'Group name is required.' });
  if (!['discussion', 'announcement', 'mixed'].includes(type) || !['private', 'approval', 'open'].includes(visibility)) return res.status(400).json({ message: 'Invalid group type or visibility.' });
  if (scope !== 'personal' && !OFFICIAL_SCOPES.includes(scope)) return res.status(400).json({ message: 'Invalid group scope.' });
  if (scope === 'personal' && type === 'announcement') return res.status(400).json({ message: 'Informal groups cannot be announcement groups.' });
  const official = scope !== 'personal';
  const campus = scope === 'university' || !official ? '' : String(req.body.campus || req.user.campus || '').trim();
  const department = ['department', 'class', 'functional'].includes(scope) ? String(req.body.department || req.user.department || '').trim() : '';
  // Authorization first, decided ONLY by the central policy (a scoped permission on an assignment that covers this
  // campus/department). Only an authorized creator is then told which fields are missing.
  if (!canCreateGroup(req.user, scope, { campus, department })) return res.status(403).json({ message: official ? 'You are not authorized to create an official group in this scope.' : 'You are not authorized to create a group.' });
  if (official && scope !== 'university' && !campus) return res.status(400).json({ message: 'Choose the campus for this group.' });
  if (['department', 'class', 'functional'].includes(scope) && !department) return res.status(400).json({ message: 'Choose the department for this group.' });
  // Name rules: official names are unique; informal groups may not imitate an official group's name.
  const clash = await Group.exists({ archived: false, scope: { $ne: 'personal' }, name: { $regex: `^${escapeRe(cleanName)}$`, $options: 'i' } });
  if (clash) return res.status(409).json({ message: official ? 'An official group with this name already exists.' : 'That name is reserved for an official group. Please choose another.' });
  let eligibleRoles = ROLES.filter(r => r !== 'Technical Admin');
  if (official && req.body.eligibleRoles !== undefined) {
    const wanted = Array.isArray(req.body.eligibleRoles) ? [...new Set(req.body.eligibleRoles.map(String))] : null;
    if (!wanted || !wanted.length || wanted.some(r => !ROLES.includes(r))) return res.status(400).json({ message: 'Choose at least one valid member role.' });
    if (wanted.includes('Technical Admin')) return res.status(400).json({ message: 'Technical Admin accounts cannot be members of official audiences.' });
    eligibleRoles = wanted;
  }
  const autoEnroll = official && req.body.autoEnroll === true;
  if (autoEnroll && !['university', 'campus', 'department'].includes(scope)) return res.status(400).json({ message: 'Automatic enrollment is only available for university, campus and department groups.' });
  const group = await Group.create({ name: cleanName.slice(0, 120), description: String(description).slice(0, 2000), type, scope, visibility, campus, department, owner: req.user._id, allowMemberDirectMessages: allowMemberDirectMessages === true, members: [req.user._id], membershipHistory: [{ user: req.user._id, joinedAt: new Date(), reason: 'owner-created' }], managers: [], publishers: [],
    // Informal groups: only the owner broadcasts until they choose otherwise. Official groups: institutional roles only
    // (administrators can adjust this on the Group permissions screen); Technical Admin is never a default poster.
    postingPolicy: 'owner', postingRoles: !official ? ROLES.filter(r => r !== 'Technical Admin') : scope === 'class' ? ['Rector', 'Campus Incharge', 'HOD', 'Teacher'] : ['Rector', 'Campus Incharge', 'HOD'],
    ...(official ? { eligibleRoles, autoEnroll } : {}) });
  let enrolled = 0;
  if (autoEnroll) enrolled = await enrollEligibleInGroup(group);
  await audit(req.user, 'group.created', 'Group', group._id, scope, { groupName: group.name, official, autoEnroll, enrolled });
  res.status(201).json({ ...group.toObject(), enrolled });
});
router.post('/groups/:id/join', async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group || group.archived) return res.status(404).json({ message: 'Group unavailable.' });
  if (!inGroupScope(req.user, group)) return res.status(403).json({ message: 'You are not eligible for this group scope.' });
  if (memberOf(group, req.user._id)) return res.json({ message: 'You are already a member.', group });
  if (group.visibility === 'private') return res.status(403).json({ message: 'This group is invite-only.' });
  if (group.visibility === 'approval') {
    const existing = group.joinRequests.find(r => id(r.user) === id(req.user._id) && r.status === 'pending');
    if (!existing) group.joinRequests.push({ user: req.user._id, status: 'pending', requestedAt: new Date() });
    await group.save();
    await audit(req.user, 'group.join_request.created', 'Group', group._id, group.scope);
    await notifyUsers([group.owner, ...(group.managers || [])], { type: 'group-join-request', groupId: String(group._id), preview: 'A group join request needs review' });
    return res.status(202).json({ message: 'Join request submitted for approval.' });
  }
  group.members.push(req.user._id);
  group.membershipHistory.push({ user: req.user._id, joinedAt: new Date(), reason: 'self-joined' });
  await group.save();
  await audit(req.user, 'group.member.joined', 'Group', group._id, group.scope);
  res.json({ message: 'You joined the group.', group });
});
router.patch('/groups/:id/join-requests/:requestId', async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group || group.archived) return res.status(404).json({ message: 'Group not found.' });
  if (!canManageGroup(req.user, group, 'groups:members:manage')) return res.status(403).json({ message: 'You cannot manage membership for this group.' });
  const request = group.joinRequests.id(req.params.requestId);
  if (!request || request.status !== 'pending') return res.status(404).json({ message: 'Pending join request not found.' });
  if (!['approve', 'decline'].includes(req.body.decision)) return res.status(400).json({ message: 'Decision must be approve or decline.' });
  const joiningUser = await User.findById(request.user);
  if (req.body.decision === 'approve') {
    if (!joiningUser || joiningUser.status !== 'active' || !inGroupScope(joiningUser, group)) return res.status(403).json({ message: 'The user is no longer eligible for this group.' });
    if (!memberOf(group, joiningUser._id)) {
      group.members.push(joiningUser._id);
      group.membershipHistory.push({ user: joiningUser._id, joinedAt: new Date(), reason: 'approved-join-request' });
    }
    request.status = 'approved';
  } else request.status = 'declined';
  request.decidedBy = req.user._id; request.decidedAt = new Date(); await group.save();
  await audit(req.user, `group.join_request.${request.status}`, 'Group', group._id, group.scope, { userId: id(request.user) });
  res.json({ message: `Join request ${request.status}.` });
});

export default router;
