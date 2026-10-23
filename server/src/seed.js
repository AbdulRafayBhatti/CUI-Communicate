import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'url';
import { User, Group } from './models/index.js';
import { runMigrations } from './services/migration.js';
import { syncAllDefaultMemberships } from './services/enrollment.js';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@12345';
const CAMPUS = 'Islamabad';
const DEPARTMENT = 'Computer Science';

const demoUsers = [
  { name: 'Technical_Admin_1', email: 'Technical_Admin_1@comsats.edu.pk', role: 'Technical Admin', campus: '', department: '', assignments: [{ role: 'Technical Admin', scope: 'university', campus: '', department: '', permissions: ['system:technical', 'accounts:recover'], active: true }] },
  { name: 'Rector_1', email: 'Rector_1@comsats.edu.pk', role: 'Rector', campus: '', department: '', assignments: [{ role: 'Rector', scope: 'university', campus: '', department: '', permissions: ['users:manage', 'roles:assign', 'groups:manage', 'groups:members:manage', 'groups:posting:manage', 'groups:create:university', 'groups:create:campus', 'groups:create:department', 'groups:create:class', 'groups:create:functional', 'broadcast:send'], active: true }] },
  { name: 'Incharge_1', email: 'Incharge_1@comsats.edu.pk', role: 'Campus Incharge', campus: CAMPUS, department: '', assignments: [{ role: 'Campus Incharge', scope: 'campus', campus: CAMPUS, department: '', permissions: ['users:manage', 'roles:assign', 'groups:manage', 'groups:members:manage', 'groups:posting:manage', 'groups:create:campus', 'groups:create:department', 'groups:create:class', 'groups:create:functional', 'broadcast:send'], active: true }] },
  { name: 'HOD_1', email: 'HOD_1@comsats.edu.pk', role: 'HOD', campus: CAMPUS, department: DEPARTMENT, assignments: [{ role: 'HOD', scope: 'department', campus: CAMPUS, department: DEPARTMENT, permissions: ['users:manage', 'roles:assign', 'groups:manage', 'groups:members:manage', 'groups:posting:manage', 'groups:create:department', 'groups:create:class', 'groups:create:functional', 'broadcast:send'], active: true }] },
  { name: 'Coordinator_1', email: 'Coordinator_1@comsats.edu.pk', role: 'Department Coordinator', campus: CAMPUS, department: DEPARTMENT, assignments: [{ role: 'Department Coordinator', scope: 'department', campus: CAMPUS, department: DEPARTMENT, permissions: ['users:manage', 'roles:assign', 'groups:manage', 'groups:members:manage', 'groups:create:department'], active: true }] },
  { name: 'Faculty_1', email: 'Faculty_1@comsats.edu.pk', role: 'Teacher', campus: CAMPUS, department: DEPARTMENT, assignments: [{ role: 'Teacher', scope: 'class', campus: CAMPUS, department: DEPARTMENT, permissions: ['groups:create:class'], active: true }] },
  { name: 'Student_1', email: 'Student_1@comsats.edu.pk', role: 'Student', campus: CAMPUS, department: DEPARTMENT, assignments: [{ role: 'Student', scope: 'department', campus: CAMPUS, department: DEPARTMENT, permissions: [], active: true }] },
  { name: 'Student_2', email: 'Student_2@comsats.edu.pk', role: 'Student', campus: CAMPUS, department: DEPARTMENT, assignments: [{ role: 'Student', scope: 'department', campus: CAMPUS, department: DEPARTMENT, permissions: [], active: true }] },
  { name: 'Employee_1', email: 'Employee_1@comsats.edu.pk', role: 'Employee account', campus: CAMPUS, department: DEPARTMENT, assignments: [{ role: 'Employee account', scope: 'department', campus: CAMPUS, department: DEPARTMENT, permissions: [], active: true }] },
];

const ALL = ['Technical Admin', 'Rector', 'Campus Incharge', 'HOD', 'Department Coordinator', 'Teacher', 'Student', 'Employee account'];
const NON_ADMIN = ALL.filter(r => r !== 'Technical Admin');
const STAFF_AND_STUDENTS = ['Rector_1', 'Incharge_1', 'HOD_1', 'Coordinator_1', 'Faculty_1', 'Student_1', 'Student_2', 'Employee_1'];

// Official groups are audiences. postingRoles decide which MEMBERS may broadcast; Rector/Campus Incharge/HOD/Coordinator
// additionally broadcast through their scoped `broadcast:send` permission (Rector, Campus Incharge, HOD). A Department
// Coordinator has no default broadcast right; the HOD can delegate it. Technical Admin is never a poster.
const officialGroups = [
  { name: 'Everyone', description: 'Every account at the university.', scope: 'university', autoEnroll: true, owner: 'Rector_1', members: ['Technical_Admin_1', ...STAFF_AND_STUDENTS], managers: ['Rector_1'], postingRoles: ['Rector'], eligibleRoles: ALL },
  { name: 'IslamabadCampus', description: 'The Islamabad campus community.', scope: 'campus', autoEnroll: true, owner: 'Incharge_1', members: STAFF_AND_STUDENTS, managers: ['Incharge_1'], postingRoles: ['Rector', 'Campus Incharge'], eligibleRoles: NON_ADMIN },
  { name: 'IslamabadCampus_ComputerScience_Department', description: 'Computer Science department, Islamabad campus.', scope: 'department', autoEnroll: true, owner: 'HOD_1', members: STAFF_AND_STUDENTS, managers: ['HOD_1', 'Coordinator_1'], postingRoles: ['Rector', 'Campus Incharge', 'HOD'], eligibleRoles: NON_ADMIN },
  { name: 'CS_Faculty', description: 'Computer Science faculty and leadership.', scope: 'functional', owner: 'Coordinator_1', members: ['HOD_1', 'Coordinator_1', 'Faculty_1'], managers: ['HOD_1', 'Coordinator_1'], postingRoles: ['HOD', 'Department Coordinator', 'Teacher'], eligibleRoles: ['HOD', 'Department Coordinator', 'Teacher'] },
  { name: 'BCS_6A', description: 'BCS Semester 6, Section A class.', scope: 'class', owner: 'Faculty_1', members: ['Faculty_1', 'Student_1', 'Student_2'], managers: ['Faculty_1'], postingRoles: ['Rector', 'Campus Incharge', 'HOD', 'Teacher'], eligibleRoles: ['Teacher', 'Student'] },
  { name: 'Student_Help_Desk', description: 'Student support from coordinators and faculty.', scope: 'functional', owner: 'Coordinator_1', members: ['Coordinator_1', 'Faculty_1', 'Student_1', 'Student_2'], managers: ['Coordinator_1'], postingRoles: ['Department Coordinator', 'Teacher'], eligibleRoles: ['Department Coordinator', 'Teacher', 'Student'] }
];
// Informal groups: same broadcast/inbox model, owner-controlled, members are invitees who accepted.
const informalGroups = [
  { name: 'Project_Team', description: 'Final-year project coordination.', owner: 'Student_1', members: ['Student_1', 'Student_2'], visibility: 'private', postingPolicy: 'members' },
  { name: 'Study_Group', description: 'Open study group. Join to receive updates.', owner: 'Student_2', members: ['Student_2'], visibility: 'open', postingPolicy: 'owner' }
];

async function upsertGroup(def, users) {
  const ids = names => names.map(n => users[n]._id);
  const official = def.scope !== undefined;
  const scope = official ? def.scope : 'personal';
  const filter = official ? { name: def.name, scope: { $ne: 'personal' } } : { name: def.name, scope: 'personal', owner: users[def.owner]._id };
  const base = {
    description: def.description, type: 'discussion', scope, archived: false,
    campus: scope === 'university' || scope === 'personal' ? '' : CAMPUS,
    department: ['department', 'class', 'functional'].includes(scope) ? DEPARTMENT : '',
    owner: users[def.owner]._id, visibility: def.visibility || 'open', postingPolicy: def.postingPolicy || 'publishers',
    ...(official ? { postingRoles: def.postingRoles, eligibleRoles: def.eligibleRoles, autoEnroll: !!def.autoEnroll, managers: ids(def.managers || []) } : {})
  };
  let group = await Group.findOne(filter);
  if (!group) group = await Group.create({ name: def.name, ...base, members: [], membershipHistory: [] });
  else await Group.updateOne({ _id: group._id }, { $set: base });
  // Add only the members that are missing: re-running never duplicates, resets history, or re-adds removed users.
  const fresh = await Group.findById(group._id).select('members removedUsers');
  const missing = ids(def.members).filter(id => !fresh.members.some(m => m.equals(id)) && !(fresh.removedUsers || []).some(m => m.equals(id)));
  if (missing.length) await Group.updateOne({ _id: group._id }, { $addToSet: { members: { $each: missing } }, $push: { membershipHistory: { $each: missing.map(user => ({ user, joinedAt: new Date(), leftAt: null, reason: 'seed' })) } } });
  return group._id;
}

/** Create/refresh demo users and groups. Idempotent; callable from tests. Returns counts for logging. */
export async function seedDatabase() {
  await runMigrations();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const users = {};
  for (const data of demoUsers) {
    const email = data.email.toLowerCase();
    await User.updateOne({ email }, { $set: { ...data, email, passwordHash, status: 'active' } }, { upsert: true, runValidators: true, setDefaultsOnInsert: true });
    users[data.name] = await User.findOne({ email });
  }
  for (const def of officialGroups) await upsertGroup(def, users);
  for (const def of informalGroups) await upsertGroup(def, users);
  await syncAllDefaultMemberships();
  return { users: demoUsers.length, officialGroups: officialGroups.length, informalGroups: informalGroups.length };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing. Set it in server/.env before running the seed.');
  await mongoose.connect(process.env.MONGO_URI);
  const result = await seedDatabase();
  console.log(`Seed complete: ${result.users} demo users, ${result.officialGroups} official groups and ${result.informalGroups} informal groups are ready.`);
  console.log(`Demo password for all seeded users: ${DEMO_PASSWORD}`);
  console.log('Use only in local development/demo environments.');
  await mongoose.disconnect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => { console.error('Seed failed:', error.message); await mongoose.disconnect().catch(() => {}); process.exitCode = 1; });
}
