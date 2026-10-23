import { Group, User } from '../models/index.js';
import { isEligibleForGroup } from './policy.js';

const same = (a, b) => String(a?._id ?? a) === String(b?._id ?? b);

/** Does the account's profile place it in this default (auto-enroll) group? */
export function matchesAutoEnrollProfile(user, group) {
  if (group.scope === 'university') return true;
  if (group.scope === 'campus') return !!user.campus && user.campus === group.campus;
  if (group.scope === 'department') return !!user.campus && !!user.department && user.campus === group.campus && user.department === group.department;
  return false;
}

/**
 * Enroll an account in every matching official default group (Everyone / its campus / its department).
 * Runs when accounts are created or their scope changes, on login, and in the seed, so membership never depends on
 * the user opening a page. Users manually removed from a group are not silently re-added. Idempotent and atomic.
 */
export async function syncDefaultMemberships(user) {
  if (!user || user.status !== 'active') return [];
  const groups = await Group.find({ archived: false, autoEnroll: true }).select('-messages');
  const joined = [];
  for (const group of groups) {
    if (group.members.some(m => same(m, user._id))) continue;
    if ((group.removedUsers || []).some(m => same(m, user._id))) continue;
    if (!matchesAutoEnrollProfile(user, group) || !isEligibleForGroup(user, group)) continue;
    const result = await Group.updateOne(
      { _id: group._id, members: { $ne: user._id } },
      { $addToSet: { members: user._id }, $push: { membershipHistory: { user: user._id, joinedAt: new Date(), leftAt: null, reason: 'default-community-membership' } } }
    );
    if (result.modifiedCount) joined.push(group.name);
  }
  return joined;
}

export async function syncAllDefaultMemberships() {
  const users = await User.find({ status: 'active' });
  let enrolled = 0;
  for (const user of users) enrolled += (await syncDefaultMemberships(user)).length;
  return enrolled;
}

/** Enroll every existing eligible account in ONE group (used when an official auto-enroll group is created). */
export async function enrollEligibleInGroup(group) {
  const users = await User.find({ status: 'active' });
  let enrolled = 0;
  for (const user of users) {
    if (group.members.some(m => same(m, user._id))) continue;
    if (!matchesAutoEnrollProfile(user, group) || !isEligibleForGroup(user, group)) continue;
    const result = await Group.updateOne(
      { _id: group._id, members: { $ne: user._id } },
      { $addToSet: { members: user._id }, $push: { membershipHistory: { user: user._id, joinedAt: new Date(), leftAt: null, reason: 'default-community-membership' } } }
    );
    if (result.modifiedCount) enrolled += 1;
  }
  return enrolled;
}
