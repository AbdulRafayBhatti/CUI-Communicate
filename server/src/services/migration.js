import { Group, Broadcast, Delivery, User } from '../models/index.js';
import { syncAllDefaultMemberships } from './enrollment.js';

// Legacy "chat room" names -> broadcast audience names. The three default groups also become auto-enroll groups.
const LEGACY_GROUPS = [
  { from: 'General Announcements', to: 'Everyone', autoEnroll: true, postingRoles: ['Rector'] },
  { from: 'Campus Announcements', to: 'IslamabadCampus', autoEnroll: true, postingRoles: ['Rector', 'Campus Incharge'] },
  { from: 'Department Announcements', to: 'IslamabadCampus_ComputerScience_Department', autoEnroll: true, postingRoles: ['Rector', 'Campus Incharge', 'HOD'] },
  { from: 'BCS-6A Class Group', to: 'BCS_6A', postingRoles: ['Rector', 'Campus Incharge', 'HOD', 'Teacher'] },
  { from: 'Faculty Coordination', to: 'CS_Faculty', postingRoles: ['HOD', 'Department Coordinator', 'Teacher'] },
  { from: 'Student Help Desk', to: 'Student_Help_Desk', postingRoles: ['Department Coordinator', 'Teacher'] }
];

/**
 * Idempotent, non-destructive migration to the group-broadcast model. Safe to run on every deploy and from the seed.
 *  - Never deletes or rewrites legacy group `messages` or the legacy `announcements` collection (kept for audit/export).
 *  - Renames legacy chat-room groups to audience names ONLY when the new name is not already taken.
 *  - Tightens legacy "everyone may post" rules on those groups, because broadcasting is a one-to-many capability.
 *  - Builds indexes for the new collections and enrolls accounts in the default groups.
 */
export async function runMigrations({ log = () => {} } = {}) {
  const report = { renamed: [], tightened: 0, enrolled: 0 };
  for (const legacy of LEGACY_GROUPS) {
    const clash = await Group.exists({ name: legacy.to, scope: { $ne: 'personal' } });
    const old = await Group.findOne({ name: legacy.from, scope: { $ne: 'personal' } }).select('_id');
    if (old && !clash) {
      const set = { name: legacy.to, postingRoles: legacy.postingRoles, postingPolicy: 'publishers' };
      if (legacy.autoEnroll) set.autoEnroll = true;
      await Group.updateOne({ _id: old._id }, { $set: set });
      report.renamed.push(`${legacy.from} -> ${legacy.to}`); report.tightened += 1;
    }
  }
  await Promise.all([Group.syncIndexes(), Broadcast.syncIndexes(), Delivery.syncIndexes(), User.syncIndexes()]);
  report.enrolled = await syncAllDefaultMemberships();
  log(`Migration: renamed ${report.renamed.length}, tightened ${report.tightened}, new default memberships ${report.enrolled}.`);
  return report;
}
