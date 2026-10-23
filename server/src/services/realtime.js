import { User } from '../models/index.js';

let ioServer = null;

export function setRealtimeServer(io) {
  ioServer = io;
}

/** Send a generic, access-safe notification to a currently authenticated user's active sockets. */
export async function notifyUser(userId, notification) {
  if (!ioServer || !userId) return;
  const user = await User.findById(userId).select('status securityVersion');
  if (!user || user.status !== 'active') return;
  const sockets = await ioServer.in(`user:${String(user._id)}`).fetchSockets();
  for (const socket of sockets) {
    if (socket.data.authVersion === user.securityVersion) socket.emit('notification:new', notification);
  }
}

export async function notifyUsers(userIds, notification) {
  const unique = [...new Set((userIds || []).map(value => String(value?._id ?? value ?? '')).filter(Boolean))];
  await Promise.all(unique.map(userId => notifyUser(userId, notification).catch(() => {})));
}

/**
 * Deliver events to many users in one pass. Each item is { userId, securityVersion, events: [{ name, payload }] }.
 * Only sockets whose authentication version still matches the account are used, so revoked sessions get nothing.
 * Socket.IO is a best-effort live channel: MongoDB (Delivery documents) remains the source of truth.
 */
export async function deliverToUsers(items) {
  if (!ioServer || !items?.length) return;
  const byUser = new Map(items.map(item => [String(item.userId), item]));
  const sockets = await ioServer.in([...byUser.keys()].map(userId => `user:${userId}`)).fetchSockets();
  for (const socket of sockets) {
    const item = byUser.get(String(socket.data.userId));
    if (!item || socket.data.authVersion !== item.securityVersion) continue;
    for (const event of item.events) socket.emit(event.name, event.payload);
  }
}
