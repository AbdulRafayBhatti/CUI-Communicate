import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { Broadcast, Delivery, Group, User } from '../models/index.js';
import { canBroadcastToGroup } from '../services/policy.js';
import { deliverToUsers } from '../services/realtime.js';
import { BroadcastError, escapeRegex, listTargetableGroups, previewRecipientCount, recipientView, sendBroadcast, unreadCountFor } from '../services/broadcast.js';

// requireAuth is applied by the parent router (routes/api.js) before this router is reached.
const router = Router();
const wrapAsync = handler => handler.constructor?.name === 'AsyncFunction' ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) : handler;
for (const method of ['get', 'post']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map(wrapAsync));
}

const idStr = value => String(value?._id ?? value ?? '');
const DEFAULT_LIMIT = 20, MAX_LIMIT = 50;
const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: Number(process.env.BROADCAST_RATE_MAX) || 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => idStr(req.user?._id),
  message: { message: 'You are sending messages too quickly. Please wait a few minutes.' }
});

router.get('/audiences', async (req, res) => {
  res.json(await listTargetableGroups(req.user, String(req.query.q || '').trim()));
});

router.post('/preview', async (req, res) => {
  res.json({ recipientCount: await previewRecipientCount(req.user, req.body?.groupIds) });
});

router.post('/', sendLimiter, async (req, res) => {
  const { broadcast, recipientCount, duplicate } = await sendBroadcast({ sender: req.user, groupIds: req.body?.groupIds, body: req.body?.body, clientMessageId: req.body?.clientMessageId });
  res.status(duplicate ? 200 : 201).json({ ok: true, duplicate, recipientCount, broadcast: { _id: broadcast._id, body: broadcast.body, createdAt: broadcast.createdAt, groups: broadcast.groups } });
});

router.get('/unread-count', async (req, res) => res.json({ unreadCount: await unreadCountFor(req.user._id) }));

router.get('/inbox', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const filter = { recipient: req.user._id };
  if (req.query.unread === '1' || req.query.unread === 'true') filter.readAt = null;
  if (req.query.cursor) {
    if (!mongoose.isValidObjectId(req.query.cursor)) return res.status(400).json({ message: 'Invalid cursor.' });
    filter._id = { $lt: req.query.cursor };
  }
  if (req.query.groupId) {
    if (!mongoose.isValidObjectId(req.query.groupId)) return res.status(400).json({ message: 'Invalid group.' });
    filter.via = req.query.groupId;
  }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    // Search is confined to broadcasts that were delivered to THIS user.
    const mine = await Delivery.find({ recipient: req.user._id }).distinct('broadcast');
    const matches = await Broadcast.find({ _id: { $in: mine }, body: { $regex: escapeRegex(q), $options: 'i' } }).select('_id');
    filter.broadcast = { $in: matches.map(m => m._id) };
  }
  const rows = await Delivery.find(filter).sort({ _id: -1 }).limit(limit + 1).populate({ path: 'broadcast', populate: { path: 'sender', select: 'name role avatarColor' } });
  const page = rows.slice(0, limit);
  const items = page.filter(row => row.broadcast).map(row => {
    const names = new Map((row.broadcast.groups || []).map(g => [String(g._id), g.name]));
    return recipientView(row.broadcast, row.broadcast.sender, row, names);
  });
  res.json({ items, nextCursor: rows.length > limit ? idStr(page[page.length - 1]._id) : null, unreadCount: await unreadCountFor(req.user._id) });
});

router.get('/sent', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const filter = { sender: req.user._id };
  if (req.query.cursor && mongoose.isValidObjectId(req.query.cursor)) filter._id = { $lt: req.query.cursor };
  const rows = await Broadcast.find(filter).sort({ _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map(async b => ({
    _id: String(b._id), body: b.body, createdAt: b.createdAt, status: b.status, groups: b.groups, recipientCount: b.recipientCount,
    readCount: await Delivery.countDocuments({ broadcast: b._id, readAt: { $ne: null } })
  })));
  res.json({ items, nextCursor: rows.length > limit ? idStr(page[page.length - 1]._id) : null });
});

router.post('/read-all', async (req, res) => {
  const result = await Delivery.updateMany({ recipient: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
  await deliverToUsers([{ userId: idStr(req.user._id), securityVersion: req.user.securityVersion, events: [{ name: 'broadcast:read', payload: { all: true, unreadCount: 0 } }] }]).catch(() => {});
  res.json({ ok: true, marked: result.modifiedCount ?? 0, unreadCount: 0 });
});

// ---- Group conversation view (per-user thread) ------------------------------------------------------------------
// NOT a shared timeline: it is assembled ONLY from (a) broadcasts that were delivered to the caller through this group
// and (b) broadcasts the caller sent to it. Someone who joins later, or who was never reached, sees nothing earlier.
const THREAD_LIMIT = 30;
async function loadThreadGroup(req, res) {
  if (!mongoose.isValidObjectId(req.params.groupId)) { res.status(404).json({ message: 'Group not found.' }); return null; }
  const group = await Group.findById(req.params.groupId).select('-messages');
  if (!group) { res.status(404).json({ message: 'Group not found.' }); return null; }
  return group;
}

router.get('/thread/:groupId', async (req, res) => {
  const group = await loadThreadGroup(req, res); if (!group) return;
  const me = req.user._id, meId = idStr(me);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || THREAD_LIMIT, 1), 60);
  if (req.query.cursor && !mongoose.isValidObjectId(req.query.cursor)) return res.status(400).json({ message: 'Invalid cursor.' });
  const [receivedIds, sentRows] = await Promise.all([
    Delivery.find({ recipient: me, via: group._id }).distinct('broadcast'),
    Broadcast.find({ sender: me, 'groups._id': group._id }).select('_id')
  ]);
  const isMember = group.members.some(m => idStr(m) === meId);
  const all = [...new Set([...receivedIds.map(idStr), ...sentRows.map(r => idStr(r._id))])];
  // No delivery, nothing sent and not a member: the caller has no relationship with this group's messages.
  if (!all.length && !isMember) return res.status(404).json({ message: 'Group not found.' });
  const older = (req.query.cursor ? all.filter(i => i < String(req.query.cursor)) : all).sort().reverse();
  const pageIds = older.slice(0, limit);
  const [rows, mine] = await Promise.all([
    Broadcast.find({ _id: { $in: pageIds } }).populate('sender', 'name role avatarColor'),
    Delivery.find({ recipient: me, broadcast: { $in: pageIds } }).select('broadcast via readAt')
  ]);
  const delivery = new Map(mine.map(d => [idStr(d.broadcast), d]));
  const gid = idStr(group._id);
  const items = rows.sort((a, b) => idStr(a._id).localeCompare(idStr(b._id))).map(b => {
    const d = delivery.get(idStr(b._id)), sent = idStr(b.sender?._id) === meId;
    const names = new Map((b.groups || []).map(g => [idStr(g._id), g.name]));
    const reached = sent ? (b.groups || []).map(g => idStr(g._id)) : (d?.via || []).map(idStr);
    return {
      kind: sent ? 'sent' : 'received', mine: sent, readAt: d?.readAt || null,
      broadcast: { _id: idStr(b._id), body: b.body, createdAt: b.createdAt, sender: { _id: idStr(b.sender?._id), name: b.sender?.name, role: b.sender?.role, avatarColor: b.sender?.avatarColor }, alsoTo: reached.filter(g => g !== gid).map(g => names.get(g)).filter(Boolean) }
    };
  });
  res.json({
    group: { _id: gid, name: group.name, description: group.description, scope: group.scope, official: group.scope !== 'personal', isMember, memberCount: isMember ? group.members.length : null, archived: !!group.archived, canBroadcast: canBroadcastToGroup(req.user, group) },
    items, nextCursor: older.length > limit ? pageIds[pageIds.length - 1] : null,
    unreadInGroup: await Delivery.countDocuments({ recipient: me, via: group._id, readAt: null })
  });
});

// Opening the group conversation marks that group's delivered messages as read for THIS user only.
router.post('/thread/:groupId/read', async (req, res) => {
  const group = await loadThreadGroup(req, res); if (!group) return;
  const unread = await Delivery.find({ recipient: req.user._id, via: group._id, readAt: null }).select('broadcast');
  if (unread.length) await Delivery.updateMany({ _id: { $in: unread.map(d => d._id) } }, { $set: { readAt: new Date() } });
  const unreadCount = await unreadCountFor(req.user._id);
  if (unread.length) await deliverToUsers([{ userId: idStr(req.user._id), securityVersion: req.user.securityVersion, events: [{ name: 'broadcast:read', payload: { broadcastIds: unread.map(d => idStr(d.broadcast)), unreadCount } }] }]).catch(() => {});
  res.json({ ok: true, marked: unread.length, unreadCount });
});

router.get('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Message not found.' });
  const broadcast = await Broadcast.findById(req.params.id).populate('sender', 'name role avatarColor');
  if (!broadcast) return res.status(404).json({ message: 'Message not found.' });
  // Access is decided by THIS user's delivery record (or authorship), never by current group membership alone.
  const delivery = await Delivery.findOne({ broadcast: broadcast._id, recipient: req.user._id });
  if (delivery) {
    const names = new Map((broadcast.groups || []).map(g => [String(g._id), g.name]));
    return res.json({ role: 'recipient', ...recipientView(broadcast, broadcast.sender, delivery, names) });
  }
  if (idStr(broadcast.sender) === idStr(req.user._id)) {
    return res.json({ role: 'sender', broadcast: { _id: String(broadcast._id), body: broadcast.body, createdAt: broadcast.createdAt, groups: broadcast.groups, recipientCount: broadcast.recipientCount, status: broadcast.status, readCount: await Delivery.countDocuments({ broadcast: broadcast._id, readAt: { $ne: null } }) } });
  }
  // 404 rather than 403: do not confirm that a message exists to people it was never delivered to.
  res.status(404).json({ message: 'Message not found.' });
});

router.post('/:id/read', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Message not found.' });
  const delivery = await Delivery.findOne({ broadcast: req.params.id, recipient: req.user._id });
  if (!delivery) return res.status(404).json({ message: 'Message not found.' });
  if (!delivery.readAt) {
    await Delivery.updateOne({ _id: delivery._id, readAt: null }, { $set: { readAt: new Date() } });
    const unreadCount = await unreadCountFor(req.user._id);
    const broadcast = await Broadcast.findById(req.params.id).select('sender');
    const events = [{ userId: idStr(req.user._id), securityVersion: req.user.securityVersion, events: [{ name: 'broadcast:read', payload: { broadcastId: req.params.id, unreadCount } }] }];
    // Read receipt for the author's "Sent" view (counts only; never who read it).
    if (broadcast && idStr(broadcast.sender) !== idStr(req.user._id)) {
      const readCount = await Delivery.countDocuments({ broadcast: broadcast._id, readAt: { $ne: null } });
      const author = await User.findById(broadcast.sender).select('securityVersion status');
      if (author?.status === 'active') events.push({ userId: idStr(broadcast.sender), securityVersion: author.securityVersion, events: [{ name: 'broadcast:receipt', payload: { broadcastId: req.params.id, readCount } }] });
    }
    await deliverToUsers(events).catch(() => {});
  }
  res.json({ ok: true, unreadCount: await unreadCountFor(req.user._id) });
});

export default router;
