import { AuditLog, Group } from '../models/index.js';

export const ROLES = [
  'Technical Admin', 'Rector', 'Campus Incharge', 'HOD',
  'Department Coordinator', 'Teacher', 'Student', 'Employee account'
];

const asId = value => String(value?._id ?? value ?? '');
const activeAssignments = user => (user?.assignments || []).filter(a => a.active !== false);
const primaryAssignment = user => user?.role ? [{
  role: user.role,
  campus: user.campus || '',
  department: user.department || '',
  scope: user.role === 'Rector' || user.role === 'Technical Admin' ? 'university' : user.role === 'Campus Incharge' ? 'campus' : 'department',
  permissions: []
}] : [];
const roleAssignments = user => {
  const active = activeAssignments(user);
  // The primary role remains valid even if older data predates assignment records.
  if (user?.role && !active.some(a => a.role === user.role && (a.campus || '') === (user.campus || '') && (a.department || '') === (user.department || ''))) {
    return [...active, ...primaryAssignment(user)];
  }
  return active.length ? active : primaryAssignment(user);
};

function assignmentCovers(a, target = {}) {
  const scope = target.scope;
  const validUniversityAssignment = a.scope === 'university' && !a.campus && !a.department;
  if (!scope) {
    if (target.campus && a.scope !== 'university' && (!a.campus || a.campus !== target.campus)) return false;
    if (target.department && a.scope !== 'university' && (!a.department || a.department !== target.department)) return false;
    return true;
  }
  if (scope === 'university') return validUniversityAssignment;
  if (validUniversityAssignment) return true;
  if (target.campus && (!a.campus || a.campus !== target.campus)) return false;
  if (scope === 'campus') return a.scope === 'campus';
  if (scope === 'department') {
    if (a.scope === 'campus') return true;
    return a.scope === 'department' && !!target.department && !!a.department && a.department === target.department;
  }
  if (scope === 'class') {
    if (a.scope === 'campus') return true;
    if (a.scope === 'department') return !!target.department && !!a.department && a.department === target.department;
    return ['department', 'class'].includes(a.scope) && !!target.department && !!a.department && a.department === target.department;
  }
  if (scope === 'functional') {
    if (a.scope === 'campus') return true;
    if (a.scope === 'department') return !!target.department && !!a.department && a.department === target.department;
    return ['department', 'functional'].includes(a.scope) && (!target.department || (!!a.department && a.department === target.department));
  }
  return false;
}

export function hasScopedPermission(user, permission, target = {}) {
  return roleAssignments(user).some(a =>
    Array.isArray(a.permissions) && a.permissions.includes(permission) && assignmentCovers(a, target)
  );
}

export function hasRoleInScope(user, roles, target = {}) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return roleAssignments(user).some(a => allowed.includes(a.role) && assignmentCovers(a, target));
}

export function rolesInScope(user, target = {}) {
  const scope = target.scope;
  return [...new Set(roleAssignments(user).filter(a => {
    if (scope === 'university' || scope === 'personal' || !scope) return true;
    if (a.scope === 'university' && !a.campus && !a.department) return true;
    if (target.campus && (!a.campus || a.campus !== target.campus)) return false;
    if (scope === 'campus') return !!target.campus;
    if (['department', 'class', 'functional'].includes(scope)) {
      // A campus-level assignment is in the department's campus; a department-level
      // assignment must match that department. A role assignment never crosses campuses.
      return !!target.campus && (!a.department || !target.department || a.department === target.department);
    }
    return false;
  }).map(a => a.role))];
}

export function isInOrgScope(user, target = {}) {
  if (!user || user.status !== 'active') return false;
  if (target.scope === 'personal' || target.scope === 'university') return true;
  return roleAssignments(user).some(a => {
    if (a.scope === 'university' && !a.campus && !a.department) return true;
    if (!target.campus || !a.campus || a.campus !== target.campus) return false;
    if (['department', 'class', 'functional'].includes(target.scope) && target.department) {
      return !a.department || a.department === target.department;
    }
    return true;
  });
}

export function hasRolePermission(user, roles, permission, target = {}) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return roleAssignments(user).some(a => allowed.includes(a.role) && Array.isArray(a.permissions) && a.permissions.includes(permission) && assignmentCovers(a, target));
}

export function canManageInstitutionalUsers(actor, target = null) {
  if (!actor || actor.status !== 'active' || actor.role === 'Technical Admin') return false;
  const assignments = roleAssignments(actor);
  if (assignments.some(a => a.role === 'Rector' && a.scope === 'university' && a.permissions?.includes('users:manage') && assignmentCovers(a, { scope: 'university' }))) {
    return !target || target.role !== 'Technical Admin';
  }
  if (assignments.some(a => a.role === 'Campus Incharge' && a.scope === 'campus' && a.campus && a.permissions?.includes('users:manage') && (!target || (target.campus === a.campus && !['Technical Admin', 'Rector', 'Campus Incharge'].includes(target.role))))) return true;
  if (assignments.some(a => a.role === 'HOD' && a.scope === 'department' && a.campus && a.department && a.permissions?.includes('users:manage') && (!target || (target.campus === a.campus && target.department === a.department && ['Department Coordinator', 'Teacher', 'Student', 'Employee account'].includes(target.role))))) return true;
  if (assignments.some(a => a.role === 'Department Coordinator' && a.scope === 'department' && a.campus && a.department && a.permissions?.includes('users:manage') && (!target || (target.campus === a.campus && target.department === a.department && ['Teacher', 'Student', 'Employee account'].includes(target.role))))) return true;
  return false;
}

export function canAssignRole(actor, role, target = {}) {
  if (!actor || actor.status !== 'active' || !ROLES.includes(role) || role === 'Technical Admin' || actor.role === 'Technical Admin') return false;
  if (role === 'Rector' && (target.campus || target.department)) return false;
  if (role === 'Campus Incharge' && (!target.campus || target.department)) return false;
  if (['HOD', 'Department Coordinator', 'Teacher', 'Student', 'Employee account'].includes(role) && (!target.campus || !target.department)) return false;

  for (const a of roleAssignments(actor)) {
    if (!a.permissions?.includes('roles:assign')) continue;
    if (a.role === 'Rector' && a.scope === 'university' && assignmentCovers(a, { scope: 'university' })) return true;
    if (a.role === 'Campus Incharge' && a.scope === 'campus' && a.campus && a.campus === target.campus && !['Rector', 'Campus Incharge'].includes(role)) return true;
    if (a.role === 'HOD' && a.scope === 'department' && a.campus === target.campus && a.department === target.department && ['Department Coordinator', 'Teacher', 'Student', 'Employee account'].includes(role)) return true;
    if (a.role === 'Department Coordinator' && a.scope === 'department' && a.campus === target.campus && a.department === target.department && ['Teacher', 'Student', 'Employee account'].includes(role)) return true;
  }
  return false;
}

export function canOwnGroup(actor, group) {
  if (!actor || !group || actor.status !== 'active') return false;
  const target = { scope: group.scope, campus: group.campus, department: group.department };
  const withinScope = (!group.campus || actor.campus === group.campus || roleAssignments(actor).some(a => a.scope === 'university' || a.campus === group.campus)) && (!group.department || actor.department === group.department || roleAssignments(actor).some(a => a.scope === 'university' || (a.campus === group.campus && (!a.department || a.department === group.department))));
  if (group.scope === 'personal') return true;
  if (group.scope === 'university') return hasRoleInScope(actor, 'Rector', { scope: 'university' }) || hasScopedPermission(actor, 'groups:manage', target);
  if (group.scope === 'campus') return withinScope && (hasRoleInScope(actor, 'Campus Incharge', { scope: 'campus', campus: group.campus }) || hasScopedPermission(actor, 'groups:manage', target));
  if (group.scope === 'department') return withinScope && (hasRoleInScope(actor, ['HOD', 'Department Coordinator'], { scope: 'department', campus: group.campus, department: group.department }) || hasScopedPermission(actor, 'groups:manage', target));
  if (group.scope === 'class') return withinScope && (hasRoleInScope(actor, 'Teacher', { scope: 'class', campus: group.campus, department: group.department }) || hasScopedPermission(actor, 'groups:manage', target));
  if (group.scope === 'functional') return withinScope && hasScopedPermission(actor, 'groups:manage', target);
  return false;
}

export function canManageGroup(actor, group, capability = 'groups:manage') {
  if (!actor || !group || group.archived || actor.status !== 'active') return false;
  const isOwner = asId(group.owner) === asId(actor);
  const isManager = (group.managers || []).some(m => asId(m) === asId(actor));
  const target = { scope: group.scope, campus: group.campus, department: group.department };
  const withinScope = (!group.campus || actor.campus === group.campus || roleAssignments(actor).some(a => a.scope === 'university' || a.campus === group.campus)) && (!group.department || actor.department === group.department || roleAssignments(actor).some(a => a.scope === 'university' || (a.campus === group.campus && (!a.department || a.department === group.department))));
  const memberInGroup = (group.members || []).some(m => asId(m) === asId(actor));
  const delegated = withinScope && memberInGroup && (group.delegations || []).some(d => d.active !== false && asId(d.user) === asId(actor) && Array.isArray(d.capabilities) && d.capabilities.includes(capability));
  // Official posting-policy changes require a scoped institutional permission, not ownership alone.
  if (capability === 'groups:posting:manage' && group.scope !== 'personal') return hasScopedPermission(actor, capability, target) || delegated;
  if (isOwner && canOwnGroup(actor, group)) return true;
  if (isManager && memberInGroup && hasScopedPermission(actor, capability, target)) return true;
  return delegated || hasScopedPermission(actor, capability, target);
}

export function canCreateGroup(user, scope, target = {}) {
  if (scope === 'personal') return user?.status === 'active';
  if (!['university', 'campus', 'department', 'class', 'functional'].includes(scope)) return false;
  return hasScopedPermission(user, `groups:create:${scope}`, { scope, campus: target.campus, department: target.department }) ||
    hasScopedPermission(user, 'groups:create', { scope, campus: target.campus, department: target.department });
}

function assignmentSignature(user) {
  return activeAssignments(user).map(a => ({
    role: a.role, scope: a.scope, campus: a.campus || '', department: a.department || '',
    permissions: [...(a.permissions || [])].sort()
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export async function relationshipSnapshot(a, b) {
  const groups = await Group.find({ archived: false, members: { $all: [a._id, b._id] }, $or: [{ scope: 'class' }, { allowMemberDirectMessages: true }] }).select('_id scope campus department eligibleRoles allowMemberDirectMessages').lean();
  const users = [a, b].map(user => ({
    userId: asId(user._id), role: user.role, campus: user.campus || '', department: user.department || '',
    assignments: assignmentSignature(user)
  })).sort((x, y) => x.userId.localeCompare(y.userId));
  return { users, sharedClassGroupIds: groups.map(g => `${g._id}|${g.scope}|${g.campus || ''}|${g.department || ''}|${g.allowMemberDirectMessages === true ? 'direct' : 'restricted'}|${[...(g.eligibleRoles || [])].sort().join(',')}`).sort() };
}

export async function relationshipSnapshotMatches(snapshot, a, b) {
  if (!snapshot?.users || snapshot.users.length !== 2) return false;
  const current = await relationshipSnapshot(a, b);
  return JSON.stringify(snapshot.users) === JSON.stringify(current.users) &&
    JSON.stringify([...(snapshot.sharedClassGroupIds || [])].sort()) === JSON.stringify(current.sharedClassGroupIds);
}

export async function canDirectWithoutRequest(sender, recipient) {
  if (!sender || !recipient || asId(sender) === asId(recipient) || sender.status !== 'active' || recipient.status !== 'active') return false;
  if (hasRoleInScope(sender, 'Rector', { scope: 'university' }) && rolesInScope(recipient, { scope: 'university' }).includes('Student')) return true;
  if (hasRoleInScope(sender, 'Campus Incharge', { scope: 'campus', campus: recipient.campus }) && rolesInScope(recipient, { scope: 'campus', campus: recipient.campus }).includes('Student')) return true;
  if (hasRoleInScope(sender, 'HOD', { scope: 'department', campus: recipient.campus, department: recipient.department }) && rolesInScope(recipient, { scope: 'department', campus: recipient.campus, department: recipient.department }).includes('Student')) return true;
  if (hasRoleInScope(sender, 'Department Coordinator', { scope: 'department', campus: recipient.campus, department: recipient.department }) && rolesInScope(recipient, { scope: 'department', campus: recipient.campus, department: recipient.department }).includes('Student')) return true;
  const senderEmployeeScopes = roleAssignments(sender).filter(a => a.role === 'Employee account' && ['department', 'functional'].includes(a.scope) && a.campus && a.department);
  const recipientEmployeeScopes = roleAssignments(recipient).filter(a => a.role === 'Employee account' && ['department', 'functional'].includes(a.scope) && a.campus && a.department);
  if (senderEmployeeScopes.some(a => recipientEmployeeScopes.some(b => a.campus === b.campus && a.department === b.department))) return true;

  const sharedGroups = await Group.find({ archived: false, members: { $all: [sender._id, recipient._id] }, $or: [{ scope: 'class' }, { allowMemberDirectMessages: true }] }).select('scope campus department eligibleRoles allowMemberDirectMessages').lean();
  for (const group of sharedGroups) {
    const target = { scope: group.scope, campus: group.campus, department: group.department };
    const allowed = Array.isArray(group.eligibleRoles) && group.eligibleRoles.length ? group.eligibleRoles : ROLES;
    const senderRoles = rolesInScope(sender, target).filter(role => allowed.includes(role));
    const recipientRoles = rolesInScope(recipient, target).filter(role => allowed.includes(role));
    // A current shared class/course group permits the standard student/teacher relationship.
    if (group.scope === 'class') {
      const senderStudent = senderRoles.includes('Student');
      const senderTeacher = senderRoles.includes('Teacher');
      const recipientStudent = recipientRoles.includes('Student');
      const recipientTeacher = recipientRoles.includes('Teacher');
      if ((senderStudent && (recipientStudent || recipientTeacher)) || (senderTeacher && recipientStudent)) return true;
    }
    // Other groups permit student-to-student direct messages only when their owner explicitly enabled it.
    if (group.allowMemberDirectMessages && senderRoles.includes('Student') && recipientRoles.includes('Student')) return true;
  }
  return false;
}

export async function audit(actor, action, resourceType, resourceId, scope, metadata = {}, outcome = 'success') {
  await AuditLog.create({ actor: actor?._id, action, resourceType, resourceId: String(resourceId || ''), scope, metadata, outcome });
}

/** Roles whose scoped `broadcast:send` permission can authorize an official-group broadcast on its own. */
const BROADCAST_AUTHORITY_ROLES = ['Rector', 'Campus Incharge', 'HOD', 'Department Coordinator'];

/**
 * Is this account an eligible *recipient* of the group right now? Used when computing a broadcast audience, so a
 * user whose role, campus, department or account status changed stops receiving broadcasts immediately.
 */
export function isEligibleForGroup(user, group) {
  if (!user || !group || user.status !== 'active') return false;
  const target = { scope: group.scope, campus: group.campus, department: group.department };
  const eligibleRoles = Array.isArray(group.eligibleRoles) && group.eligibleRoles.length ? group.eligibleRoles : ROLES;
  if (!rolesInScope(user, target).some(role => eligibleRoles.includes(role))) return false;
  return isInOrgScope(user, target);
}

/**
 * May `user` send a broadcast to `group`? This is the single decision point used by REST and Socket.IO.
 * It is independent of "can create", "can view", "can join" and "can manage members".
 *
 * Informal (personal) groups: the owner always may; managers/publishers/members only as the group's posting policy
 *   ('owner' | 'publishers' | 'members') allows, and only while they are current members.
 * Official groups:
 *   1. an institutional sender holding the scoped `broadcast:send` permission whose assignment covers the group, or
 *   2. a current member whose role (within the group's scope) is listed in the group's `postingRoles`, or
 *   3. a current, eligible member whom the group's OWNER has chosen as a sender (`publishers`).
 * A role label alone never suffices, and Technical Admin never broadcasts through the member path.
 */
export function canBroadcastToGroup(user, group) {
  if (!user || !group || group.archived || user.status !== 'active') return false;
  const uid = asId(user._id);
  const isMember = (group.members || []).some(m => asId(m) === uid);
  if (group.scope === 'personal') {
    if (asId(group.owner) === uid) return true;
    if (!isMember) return false;
    if (group.postingPolicy === 'members') return true;
    if (group.postingPolicy === 'publishers') {
      return (group.managers || []).some(m => asId(m) === uid) || (group.publishers || []).some(p => asId(p) === uid);
    }
    return false;
  }
  const target = { scope: group.scope, campus: group.campus, department: group.department };
  if (hasRolePermission(user, BROADCAST_AUTHORITY_ROLES, 'broadcast:send', target)) return true;
  if (!isMember) return false;
  const permitted = rolesInScope(user, target).filter(role => role !== 'Technical Admin');
  if (Array.isArray(group.postingRoles) && group.postingRoles.some(role => permitted.includes(role))) return true;
  // Members the group OWNER has chosen as senders (see PATCH /groups/:id/senders). They must still be current,
  // eligible members; the owner can neither choose Technical Admin nor anyone outside the group's scope.
  return permitted.length > 0 && (group.publishers || []).some(p => asId(p) === uid);
}
