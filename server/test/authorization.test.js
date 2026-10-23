import test from 'node:test';
import assert from 'node:assert/strict';
import { canAssignRole, canCreateGroup, canManageInstitutionalUsers, canBroadcastToGroup, isEligibleForGroup, hasScopedPermission } from '../src/services/policy.js';

const user = (role, campus, department, permissions = [], scope = 'department') => ({
  _id: `${role}-${campus}-${department}`,
  role, campus, department, status: 'active',
  assignments: [{ role, campus, department, scope, permissions, active: true }]
});

const grp = (over = {}) => ({ _id: 'g1', name: 'G', scope: 'university', campus: '', department: '', archived: false, owner: 'owner-x', members: [], managers: [], publishers: [], postingRoles: [], postingPolicy: 'owner', eligibleRoles: [], ...over });

test('Technical Admin is not an institutional role manager or publisher', () => {
  const admin = user('Technical Admin', '', '', ['system:technical', 'accounts:recover'], 'university');
  assert.equal(canManageInstitutionalUsers(admin), false);
  assert.equal(canAssignRole(admin, 'Student', { campus: 'Islamabad', department: 'CS' }), false);
  assert.equal(canBroadcastToGroup(admin, grp({ members: [admin._id], postingRoles: ['Technical Admin'] })), false);
});

test('Rector permissions are university-scoped and cannot assign Technical Admin', () => {
  const rector = user('Rector', '', '', ['users:manage', 'roles:assign', 'broadcast:send'], 'university');
  assert.equal(canManageInstitutionalUsers(rector), true);
  assert.equal(canAssignRole(rector, 'Student', { campus: 'Lahore', department: 'CS' }), true);
  assert.equal(canAssignRole(rector, 'Technical Admin', { campus: '', department: '' }), false);
  assert.equal(canBroadcastToGroup(rector, grp({ members: [rector._id] })), true);
});

test('Campus and department permissions cannot cross organizational boundaries', () => {
  const incharge = user('Campus Incharge', 'Islamabad', '', ['users:manage', 'roles:assign', 'groups:create:campus'], 'campus');
  const hod = user('HOD', 'Islamabad', 'Computer Science', ['users:manage', 'roles:assign', 'groups:create:department', 'broadcast:send'], 'department');
  assert.equal(canManageInstitutionalUsers(incharge), true);
  assert.equal(canAssignRole(incharge, 'Student', { campus: 'Islamabad', department: 'CS' }), true);
  assert.equal(canAssignRole(incharge, 'Student', { campus: 'Lahore', department: 'CS' }), false);
  assert.equal(canManageInstitutionalUsers(hod, { role: 'Student', campus: 'Islamabad', department: 'Computer Science' }), true);
  assert.equal(canManageInstitutionalUsers(hod, { role: 'Student', campus: 'Islamabad', department: 'Electrical Engineering' }), false);
  const csGroup = grp({ scope: 'department', campus: 'Islamabad', department: 'Computer Science' });
  assert.equal(canBroadcastToGroup(hod, csGroup), true);
  assert.equal(canBroadcastToGroup(hod, { ...csGroup, department: 'Electrical Engineering' }), false);
  assert.equal(canBroadcastToGroup(hod, { ...csGroup, scope: 'campus', department: '' }), false);
});

test('Group creation requires an explicit scoped capability for official groups', () => {
  const student = user('Student', 'Islamabad', 'Computer Science', [], 'department');
  const teacher = user('Teacher', 'Islamabad', 'Computer Science', ['groups:create:class'], 'class');
  assert.equal(canCreateGroup(student, 'personal', {}), true);
  assert.equal(canCreateGroup(student, 'department', { campus: 'Islamabad', department: 'Computer Science' }), false);
  assert.equal(canCreateGroup(teacher, 'class', { campus: 'Islamabad', department: 'Computer Science' }), true);
  assert.equal(hasScopedPermission(teacher, 'groups:create:class', { scope: 'class', campus: 'Islamabad', department: 'Computer Science' }), true);
});

test('Malformed or empty campus assignments never grant cross-campus access', () => {
  const malformed = {
    _id: 'bad-assignment', role: 'Campus Incharge', campus: '', department: '', status: 'active',
    assignments: [{ role: 'Campus Incharge', scope: 'campus', campus: '', department: '', permissions: ['users:manage', 'roles:assign'], active: true }]
  };
  assert.equal(canManageInstitutionalUsers(malformed), false);
  assert.equal(canAssignRole(malformed, 'Student', { campus: 'Islamabad', department: 'Computer Science' }), false);
});

test('An additional scoped assignment grants only its own department authority', () => {
  const multiRole = {
    _id: 'multi-role-user', role: 'Teacher', campus: 'Lahore', department: 'Electrical Engineering', status: 'active',
    assignments: [
      { role: 'Teacher', scope: 'department', campus: 'Lahore', department: 'Electrical Engineering', permissions: [], active: true },
      { role: 'HOD', scope: 'department', campus: 'Islamabad', department: 'Computer Science', permissions: ['broadcast:send'], active: true }
    ]
  };
  const at = (campus, department) => grp({ scope: 'department', campus, department });
  assert.equal(canBroadcastToGroup(multiRole, at('Islamabad', 'Computer Science')), true);
  assert.equal(canBroadcastToGroup(multiRole, at('Islamabad', 'Electrical Engineering')), false);
  assert.equal(canBroadcastToGroup(multiRole, at('Lahore', 'Electrical Engineering')), false);
});

test('A scoped permission cannot be used to grant a role at a broader scope', () => {
  const hod = user('HOD', 'Islamabad', 'Computer Science', ['users:manage', 'roles:assign'], 'department');
  assert.equal(canAssignRole(hod, 'Student', { campus: 'Islamabad', department: 'Computer Science' }), true);
  assert.equal(canAssignRole(hod, 'Student', { campus: 'Lahore', department: 'Computer Science' }), false);
  assert.equal(canAssignRole(hod, 'Student', { campus: 'Islamabad', department: '' }), false);
});


test('Official group broadcast: a member needs an allowed role; a non-member without authority is refused', () => {
  const teacher = user('Teacher', 'Islamabad', 'Computer Science', [], 'class'); teacher._id = 't1';
  const student = user('Student', 'Islamabad', 'Computer Science', [], 'department'); student._id = 's1';
  const cls = grp({ scope: 'class', campus: 'Islamabad', department: 'Computer Science', members: ['t1', 's1'], postingRoles: ['Teacher'] });
  assert.equal(canBroadcastToGroup(teacher, cls), true);
  assert.equal(canBroadcastToGroup(student, cls), false);
  assert.equal(canBroadcastToGroup(teacher, { ...cls, members: ['s1'] }), false, 'must be a member for the member path');
  assert.equal(canBroadcastToGroup(teacher, { ...cls, postingRoles: ['HOD'] }), false);
  assert.equal(canBroadcastToGroup(teacher, { ...cls, archived: true }), false);
  assert.equal(canBroadcastToGroup({ ...teacher, status: 'suspended' }, cls), false);
});

test('Campus Incharge broadcasts to department groups in their own campus only, without being a member', () => {
  const ci = user('Campus Incharge', 'Islamabad', '', ['broadcast:send'], 'campus');
  assert.equal(canBroadcastToGroup(ci, grp({ scope: 'department', campus: 'Islamabad', department: 'Computer Science' })), true);
  assert.equal(canBroadcastToGroup(ci, grp({ scope: 'campus', campus: 'Islamabad' })), true);
  assert.equal(canBroadcastToGroup(ci, grp({ scope: 'campus', campus: 'Lahore' })), false);
  assert.equal(canBroadcastToGroup(ci, grp({ scope: 'department', campus: 'Lahore', department: 'Computer Science' })), false);
  assert.equal(canBroadcastToGroup(ci, grp({ scope: 'university' })), false, 'a campus role never reaches Everyone');
});

test('A role label without the scoped broadcast:send permission grants no institutional authority', () => {
  const rectorNoPerm = user('Rector', '', '', ['users:manage'], 'university');
  assert.equal(canBroadcastToGroup(rectorNoPerm, grp({ scope: 'university' })), false);
  const legacy = { _id: 'legacy', role: 'Rector', campus: '', department: '', status: 'active', assignments: [] };
  assert.equal(canBroadcastToGroup(legacy, grp({ scope: 'university', members: ['legacy'], postingRoles: [] })), false);
});

test('Technical Admin can never broadcast to an official group, even if listed in postingRoles', () => {
  const admin = user('Technical Admin', '', '', ['system:technical', 'broadcast:send'], 'university');
  const everyone = grp({ scope: 'university', members: [admin._id], postingRoles: ['Technical Admin', 'Rector'] });
  assert.equal(canBroadcastToGroup(admin, everyone), false);
});

test('Informal groups: owner always; others only as the posting policy allows and only while members', () => {
  const owner = { ...user('Student', 'Islamabad', 'Computer Science'), _id: 'o1' };
  const member = { ...user('Student', 'Islamabad', 'Computer Science'), _id: 'm1' };
  const stranger = { ...user('Student', 'Islamabad', 'Computer Science'), _id: 'x1' };
  const g = grp({ scope: 'personal', owner: 'o1', members: ['o1', 'm1'], postingPolicy: 'owner' });
  assert.equal(canBroadcastToGroup(owner, g), true);
  assert.equal(canBroadcastToGroup(member, g), false);
  assert.equal(canBroadcastToGroup(member, { ...g, postingPolicy: 'members' }), true);
  assert.equal(canBroadcastToGroup(member, { ...g, postingPolicy: 'publishers' }), false);
  assert.equal(canBroadcastToGroup(member, { ...g, postingPolicy: 'publishers', publishers: ['m1'] }), true);
  assert.equal(canBroadcastToGroup(stranger, { ...g, postingPolicy: 'members' }), false);
  // Owning an informal group grants no authority over official ones.
  assert.equal(canBroadcastToGroup(owner, grp({ scope: 'university', owner: 'o1', members: ['o1'] })), false);
});

test('isEligibleForGroup honours account status, role eligibility and campus scope', () => {
  const s = user('Student', 'Islamabad', 'Computer Science');
  const dept = grp({ scope: 'department', campus: 'Islamabad', department: 'Computer Science', eligibleRoles: ['Student'] });
  assert.equal(isEligibleForGroup(s, dept), true);
  assert.equal(isEligibleForGroup({ ...s, status: 'suspended' }, dept), false);
  assert.equal(isEligibleForGroup(s, { ...dept, eligibleRoles: ['Teacher'] }), false);
  assert.equal(isEligibleForGroup(s, { ...dept, campus: 'Lahore' }), false);
});

test('Owner-chosen senders may broadcast to an official group only as current, in-scope, non-Technical-Admin members', () => {
  const student = { ...user('Student', 'Islamabad', 'Computer Science', [], 'class'), _id: 's9' };
  const cls = grp({ scope: 'class', campus: 'Islamabad', department: 'Computer Science', members: ['s9'], postingRoles: ['Teacher'], publishers: ['s9'] });
  assert.equal(canBroadcastToGroup(student, cls), true, 'chosen member sends');
  assert.equal(canBroadcastToGroup(student, { ...cls, publishers: [] }), false, 'not chosen');
  assert.equal(canBroadcastToGroup(student, { ...cls, members: [] }), false, 'a chosen sender who is no longer a member cannot send');
  assert.equal(canBroadcastToGroup(student, { ...cls, campus: 'Lahore' }), false, 'outside the group scope');
  assert.equal(canBroadcastToGroup({ ...student, status: 'suspended' }, cls), false);
  const admin = { ...user('Technical Admin', '', '', ['system:technical'], 'university'), _id: 'ta9' };
  assert.equal(canBroadcastToGroup(admin, grp({ scope: 'university', members: ['ta9'], publishers: ['ta9'] })), false, 'Technical Admin cannot be chosen');
});
