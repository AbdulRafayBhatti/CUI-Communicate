import mongoose from 'mongoose';
import { Broadcast, Delivery, Group, User } from '../models/index.js';
import { audit, canBroadcastToGroup, isEligibleForGroup } from './policy.js';
import { deliverToUsers } from './realtime.js';

export class BroadcastError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const MAX_GROUPS_PER_BROADCAST = 10;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const idStr = value => String(value?._id ?? value ?? '');
export const escapeRegex = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Validate the selected group IDs and require current broadcast authority for EVERY one of them. */
export async function loadTargetGroups(sender, rawIds) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(String))];
  if (!ids.length) throw new BroadcastError(400, 'Choose at least one recipient group.');
  if (ids.length > MAX_GROUPS_PER_BROADCAST) throw new BroadcastError(400, `Choose at most ${MAX_GROUPS_PER_BROADCAST} groups per message.`);
  if (ids.some(id => !mongoose.isValidObjectId(id))) throw new BroadcastError(400, 'One or more selected groups are invalid.');
  const groups = await Group.find({ _id: { $in: ids }, archived: false }).select('-messages');
  // The same answer for "missing" and "not allowed": this endpoint is not an oracle for which groups exist.
  if (groups.length !== ids.length || groups.some(group => !canBroadcastToGroup(sender, group))) {
    await audit(sender, 'broadcast.denied', 'Broadcast', '', 'broadcast', { groupIds: ids }, 'denied').catch(() => {});
    throw new BroadcastError(403, 'You are not authorized to send to one or more of the selected groups.');
  }
  return groups;
}

/**
 * Compute the audience from CURRENT membership, account status and institutional scope.
 * Returns Map<userId, { via: [groupId], securityVersion }>. A user in several selected groups appears once.
 * The sender is never a recipient of their own broadcast (they see it under "Sent").
 */
export async function resolveRecipients(groups, senderId) {
  const memberSets = groups.map(group => new Set(group.members.map(idStr)));
  const candidateIds = [...new Set(memberSets.flatMap(set => [...set]))].filter(id => id !== idStr(senderId));
  const recipients = new Map();
  for (let i = 0; i < candidateIds.length; i += 500) {
    const users = await User.find({ _id: { $in: candidateIds.slice(i, i + 500) }, status: 'active' }).select('role campus department assignments status securityVersion');
    for (const user of users) {
      const via = groups.filter((group, index) => memberSets[index].has(idStr(user._id)) && isEligibleForGroup(user, group)).map(group => group._id);
      if (via.length) recipients.set(idStr(user._id), { via, securityVersion: user.securityVersion });
    }
  }
  return recipients;
}

export async function previewRecipientCount(sender, groupIds) {
  const groups = await loadTargetGroups(sender, groupIds);
  return (await resolveRecipients(groups, sender._id)).size;
}

export async function listTargetableGroups(user, query = '') {
  const filter = { archived: false };
  if (query) filter.name = { $regex: escapeRegex(query).slice(0, 80), $options: 'i' };
  const breadth = { university: 0, campus: 1, department: 2, class: 3, functional: 4, personal: 5 };   // broadest audience first
  const groups = (await Group.find(filter).select('-messages').sort({ name: 1 }).limit(300)).sort((a, b) => (breadth[a.scope] ?? 9) - (breadth[b.scope] ?? 9));
  return groups.filter(group => canBroadcastToGroup(user, group)).map(group => ({
    _id: group._id, name: group.name, description: group.description, scope: group.scope,
    campus: group.campus, department: group.department, official: group.scope !== 'personal',
    memberCount: group.members.length
  }));
}

export const unreadCountFor = userId => Delivery.countDocuments({ recipient: userId, readAt: null });

/** Shape of a broadcast as a RECIPIENT may see it: only the audience labels that actually reached them. */
export function recipientView(broadcast, sender, delivery, groupNames) {
  return {
    delivery: { _id: String(delivery._id), readAt: delivery.readAt || null, createdAt: delivery.createdAt || broadcast.createdAt },
    broadcast: {
      _id: String(broadcast._id), body: broadcast.body, createdAt: broadcast.createdAt,
      sender: { _id: String(sender._id), name: sender.name, role: sender.role, avatarColor: sender.avatarColor },
      groups: (delivery.via || []).map(id => ({ _id: String(id), name: groupNames.get(String(id)) || 'Group' }))
    }
  };
}

async function writeDeliveries(broadcast, recipients) {
  const existing = new Set((await Delivery.find({ broadcast: broadcast._id }).select('recipient')).map(d => idStr(d.recipient)));
  const fresh = [...recipients].filter(([userId]) => !existing.has(userId));
  for (let i = 0; i < fresh.length; i += 500) {
    const docs = fresh.slice(i, i + 500).map(([userId, info]) => ({ broadcast: broadcast._id, recipient: userId, via: info.via, readAt: null }));
    try { await Delivery.insertMany(docs, { ordered: false }); }
    catch (error) {
      // The unique (broadcast, recipient) index makes a concurrent/retried write harmless; anything else is real.
      const dup = e => e?.code === 11000 || e?.writeErrors?.every?.(w => (w.code ?? w.err?.code) === 11000);
      if (!dup(error)) throw error;
    }
  }
  return fresh;
}

async function announce(broadcast, sender, freshRecipients, recipients) {
  const names = new Map((broadcast.groups || []).map(g => [String(g._id), g.name]));
  const rows = await Delivery.find({ broadcast: broadcast._id, recipient: { $in: freshRecipients.map(([id]) => id) } }).select('recipient via readAt createdAt');
  const items = rows.map(row => {
    const info = recipients.get(idStr(row.recipient));
    const view = recipientView(broadcast, sender, row, names);
    return {
      userId: idStr(row.recipient), securityVersion: info?.securityVersion,
      events: [
        { name: 'broadcast:new', payload: view },
        // Generic notification: no message body, matching the existing DM notification contract.
        { name: 'notification:new', payload: { type: 'broadcast', broadcastId: view.broadcast._id, from: sender.name, preview: `New message from ${sender.name}` } }
      ]
    };
  });
  await deliverToUsers(items);
}

/** Finish (or resume) persistence of a pending broadcast. Safe to run any number of times. */
async function completeBroadcast(broadcast, groups, sender) {
  const recipients = await resolveRecipients(groups, sender._id);
  const fresh = await writeDeliveries(broadcast, recipients);
  const recipientCount = await Delivery.countDocuments({ broadcast: broadcast._id });
  await Broadcast.updateOne({ _id: broadcast._id }, { $set: { status: 'delivered', recipientCount } });
  broadcast.status = 'delivered'; broadcast.recipientCount = recipientCount;
  await announce(broadcast, sender, fresh, recipients).catch(() => {});
  return { recipientCount, newDeliveries: fresh.length };
}

/**
 * Persist one logical broadcast and one Delivery per eligible recipient.
 * Idempotent on (sender, clientMessageId): a retry returns the same broadcast and never creates duplicates.
 * (No multi-document transaction is used because standalone MongoDB does not support them; instead every step is
 * idempotent and a crash between steps leaves a `pending` broadcast that retry / startup recovery completes.)
 */
export async function sendBroadcast({ sender, groupIds, body, clientMessageId }) {
  const text = String(body ?? '').trim();
  if (!text || text.length > 5000) throw new BroadcastError(400, 'Message must be 1–5000 characters.');
  const key = String(clientMessageId ?? '').trim();
  if (!KEY_PATTERN.test(key)) throw new BroadcastError(400, 'A valid clientMessageId (8–80 letters, digits, - or _) is required.');
  const groups = await loadTargetGroups(sender, groupIds);
  const audienceKey = groups.map(g => idStr(g._id)).sort().join(',');

  let broadcast = await Broadcast.findOne({ sender: sender._id, clientMessageId: key });
  let duplicate = !!broadcast;
  if (!broadcast) {
    try {
      broadcast = await Broadcast.create({ sender: sender._id, body: text, clientMessageId: key, status: 'pending', groups: groups.map(g => ({ _id: g._id, name: g.name, scope: g.scope })) });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      broadcast = await Broadcast.findOne({ sender: sender._id, clientMessageId: key }); duplicate = true;
    }
  }
  if (broadcast.body !== text || broadcast.groups.map(g => idStr(g._id)).sort().join(',') !== audienceKey) {
    throw new BroadcastError(409, 'This request id was already used for a different message.');
  }
  if (broadcast.status === 'delivered') return { broadcast, recipientCount: broadcast.recipientCount, duplicate: true };

  const { recipientCount } = await completeBroadcast(broadcast, groups, sender);
  if (!duplicate) await audit(sender, 'broadcast.sent', 'Broadcast', broadcast._id, 'broadcast', { groupIds: groups.map(g => idStr(g._id)), recipientCount }).catch(() => {});
  await deliverToUsers([{ userId: idStr(sender._id), securityVersion: sender.securityVersion, events: [{ name: 'broadcast:sent', payload: { broadcastId: String(broadcast._id), recipientCount } }] }]).catch(() => {});
  return { broadcast, recipientCount, duplicate };
}

/** Startup recovery: finish broadcasts that were interrupted between persisting the message and its deliveries. */
export async function recoverPendingBroadcasts(olderThanMs = 30_000) {
  const stale = await Broadcast.find({ status: 'pending', createdAt: { $lt: new Date(Date.now() - olderThanMs) } }).limit(100);
  let recovered = 0;
  for (const broadcast of stale) {
    const sender = await User.findById(broadcast.sender);
    const groups = await Group.find({ _id: { $in: broadcast.groups.map(g => g._id) } }).select('-messages');
    if (!sender || sender.status !== 'active' || !groups.length) continue;
    await completeBroadcast(broadcast, groups, sender); recovered += 1;
  }
  return recovered;
}
