# Group broadcasting and personal inboxes

> Source of truth: `server/src/services/broadcast.js`, `server/src/routes/broadcasts.js`, `server/src/services/policy.js`
> (`canBroadcastToGroup`, `isEligibleForGroup`), `client/src/broadcast.jsx`. Verified by `server/test/broadcast.integration.test.js`.

## Core idea

**Groups are audiences, not chat rooms.** Nobody sees a shared group timeline. A sender picks one or more groups they are
authorized to message and writes a message. The server computes the eligible recipients *at send time* and gives each one a
`Delivery` record. Every recipient sees the message in their **own** inbox (Messages → Inbox). Direct Messages are a
separate module with unchanged rules.

## Data model

| Collection | Purpose | Key constraints |
|---|---|---|
| `Broadcast` | One logical message: `sender`, `body` (≤ 5000), `groups[]` (id + name + scope snapshot), `clientMessageId`, `status` (`pending`\|`delivered`), `recipientCount` | unique `(sender, clientMessageId)` |
| `Delivery` | One inbox entry per recipient: `broadcast`, `recipient`, `via[]` (selected groups that reached them), `readAt` | unique `(broadcast, recipient)`; indexes `(recipient, _id desc)`, `(recipient, readAt)` |
| `Group` | An audience. Official (`scope` university/campus/department/class/functional) or informal (`scope: personal`). New fields: `postingPolicy` (`owner`\|`publishers`\|`members`), `invitations[]`, `removedUsers[]`, `autoEnroll` | |

The message body is stored once. A recipient's access is decided by **their delivery record**, never by current group
membership.

## Group conversation screen (per-user thread)

Clicking a received message (or **Groups → Conversation**) opens the **group screen**: a chat-style history of that group,
oldest first, with the clicked message highlighted, "Load earlier messages", live updates and a message box (if you may send).
It is **not** a shared room. The server assembles it for *you* from:

1. broadcasts **delivered to you** through that group (`Delivery.via` contains the group), and
2. broadcasts **you sent** to that group.

Consequences (all covered by tests): a member who joins later sees no earlier messages; an outsider (including Technical
Admin and senior officials who were never reached) gets `404`; a removed member keeps what was delivered to them but can no
longer send; messages sent to several groups appear once in each group's thread ("also to …"). Opening the screen marks that
group's delivered messages read for you only. If a message reached you through several groups, the screen offers a switcher.

## Sending workflow (`POST /api/broadcasts`)

1. Authenticate (JWT + current `securityVersion` + active status).
2. Validate body, 1–10 group IDs and `clientMessageId` (8–80 chars of `A-Za-z0-9_-`).
3. Load the groups and require `canBroadcastToGroup` for **every** one. Missing and forbidden groups give the same `403`
   (no existence oracle). One forbidden group rejects the whole send.
4. Create the `Broadcast` (`pending`). A duplicate key means a retry: the existing broadcast is reused.
5. Compute recipients from **current** membership, `status: active`, and `isEligibleForGroup` (role, campus, department).
   The sender is excluded. A user in several selected groups appears once (`via` lists the groups).
6. Insert deliveries (`ordered: false`, duplicates ignored), set `status: delivered` and `recipientCount`.
7. Emit `broadcast:new` + `notification:new` to the recipients' personal rooms; emit `broadcast:sent` to the sender's tabs.
8. Respond `201 { ok, duplicate:false, recipientCount, broadcast }` (`200 … duplicate:true` for a retry).

**Idempotency.** Retrying with the same `clientMessageId`, body and audience returns the same broadcast and creates no new
rows. Reusing the key with a different body/audience returns `409`. The client keeps one key per identical draft and
generates a new one when the draft changes.

**Partial failure.** Standalone MongoDB has no multi-document transactions, so every step is idempotent. A crash between
steps leaves a `pending` broadcast; the next retry completes it, and `recoverPendingBroadcasts()` (run at server start) finishes
any pending broadcast older than 30 s.

## Authorization (`canBroadcastToGroup`)

Kept separate from create / view / join / manage-members. The same function is used by every REST path.

* **Informal group:** owner always; others only as `postingPolicy` allows (`members`: any current member; `publishers`:
  managers/publishers; `owner`: nobody else) and only while members.
* **Official group:** (a) the sender holds an active assignment of role Rector / Campus Incharge / HOD / Department
  Coordinator that covers the group's scope **and** carries the scoped `broadcast:send` permission; or (b) the sender is a
  current member whose role (within the group's scope) is listed in the group's `postingRoles`; or (c) the sender is a
  current, eligible member the group's **owner** has chosen as a sender (`publishers`).
* **Never:** archived group, non-active account, Technical Admin through the member path, or a role label without the
  permission/assignment. Owning an informal group grants nothing on official groups.

### Creating groups (official and informal)

`POST /api/groups` accepts `scope: 'personal'` (informal) or an official level. Authorization is decided only by the central
policy (`canCreateGroup`: a `groups:create:<level>` permission on an assignment that covers the campus/department); the
authorization check runs before field validation, so an unauthorized caller always gets `403`. `GET /api/groups/creatable`
returns what the caller may create (levels, and whether campus/department are fixed choices or free text) so the client never
duplicates policy. Official groups also accept `eligibleRoles` (never Technical Admin) and, for university/campus/department
levels, `autoEnroll: true`, which immediately enrolls every matching eligible account and every future one. Official names are
unique (case-insensitive) and informal groups cannot reuse them.

### Owner-managed senders

**Every group's owner decides which individual members may send to it** (Groups → Manage → *Who can send messages*; informal
and official groups alike). Guardrails, enforced server-side:

* Only the owner may use it (a member, or an official who is not the owner, gets `403`).
* The chosen person must be a **current member** and, for official groups, **eligible** for the group's scope. Technical Admin
  can never be chosen. The owner cannot choose themselves (owners send under their own role/permissions) and cannot change
  which *roles* may send in an official group; that stays with administrators on *Group permissions*.
* Informal groups: choosing a sender switches the posting policy from *Only me* to *Me and people I choose* automatically.
  If the policy is *Any member*, choosing individuals is refused because everyone can already send.
* At most 50 chosen senders per group. Removing a member, leaving, or archiving the group clears the grant; a stale grant is
  inert anyway because membership is re-checked on every send.
* Grants and revocations are audited (`group.sender.granted` / `.revoked`) without message content, and the person is notified.

Informal groups protect recipients: an owner who adds someone only sends an **invitation**; the person becomes a member (and
a recipient) after accepting. Official default groups (`autoEnroll`) enroll matching accounts at account creation, scope
change and login; a manual removal is remembered (`removedUsers`) and not undone.

## REST API (all require `Authorization: Bearer <jwt>`)

| Method & path | Purpose |
|---|---|
| `GET /api/broadcasts/audiences?q=` | Groups the caller may message (broadest first), with member counts only |
| `POST /api/broadcasts/preview` `{groupIds}` | Server-calculated recipient count (`403` if any group is not allowed) |
| `POST /api/broadcasts` `{groupIds, body, clientMessageId}` | Send (see above). Rate limited: `BROADCAST_RATE_MAX` (default 30) per 10 min per user |
| `GET /api/broadcasts/inbox?limit&cursor&q&unread=1&groupId` | The caller's deliveries, newest first; `{items, nextCursor, unreadCount}`. Search is confined to the caller's own deliveries |
| `GET /api/broadcasts/unread-count` | `{unreadCount}` |
| `GET /api/broadcasts/sent` | The caller's sent broadcasts with `recipientCount` and `readCount` (counts only, never who) |
| `GET /api/broadcasts/thread/:groupId?limit&cursor` | Group conversation for the caller: `{group, items (oldest→newest, kind sent/received), nextCursor, unreadInGroup}`; `404` if the caller was never reached and is not a member |
| `POST /api/broadcasts/thread/:groupId/read` | Mark this group's delivered messages read (this user only); returns `unreadCount` |
| `GET /api/broadcasts/:id` | Recipient view or sender view; `404` for everyone else |
| `POST /api/broadcasts/:id/read`, `POST /api/broadcasts/read-all` | Mark read; returns `unreadCount` |
| `GET /api/groups/creatable` | What the caller may create: informal always; official levels with campus/department constraints |
| `POST /api/groups` | Create an informal or (if permitted) official group (see above) |
| `GET /api/groups/invitations` | The caller's pending informal-group invitations |
| `POST /api/groups/:id/invitations/respond` `{decision: accept\|decline}` | Respond to an invitation |
| `POST /api/groups/:id/leave` | Leave an informal group (owner must transfer first) |
| `PATCH /api/groups/:id/settings` `{visibility, postingPolicy, description}` | Informal-group owner only |
| `GET /api/groups/:id/senders` | Owner only: members with `canSend` and `eligible` flags (and, for official groups, the roles administrators allow) |
| `PATCH /api/groups/:id/senders` `{userId, canSend}` | Owner only: allow/stop a member from sending to this group |

Removed (they bypassed this model): `GET /api/groups/:id/messages` and every `/api/announcements…` route.

## Socket.IO

Authenticated at the handshake (JWT, active account, `securityVersion`). Each socket joins only `user:<id>`. There is
**no** `group:join` / `group:message` and no group room.

| Event (server → client) | Payload |
|---|---|
| `broadcast:new` | `{ delivery:{_id, readAt, createdAt}, broadcast:{_id, body, createdAt, sender:{_id,name,role,avatarColor}, groups:[{_id,name}]} }` — `groups` lists only the audiences that reached *this* recipient |
| `notification:new` | `{ type:'broadcast', broadcastId, from, preview:'New message from …' }` — no message body |
| `broadcast:read` | `{ broadcastId, unreadCount }`, `{ broadcastIds:[…], unreadCount }` (a whole group conversation opened) or `{ all:true, unreadCount:0 }` — sent to the reader's other tabs |
| `broadcast:receipt` | `{ broadcastId, readCount }` — to the author |
| `broadcast:sent` | `{ broadcastId, recipientCount }` — to the author's tabs |

Socket.IO is a best-effort live channel. **MongoDB is the source of truth:** the client de-duplicates events by delivery id
and re-synchronizes the inbox and unread count from `GET /api/broadcasts/inbox` on every (re)connect. Events are sent only
to sockets whose `securityVersion` still matches the account.

## Known limitations

* Inbox search is a case-insensitive substring match over the caller's delivered messages (no text index).
* The audience is calculated once at send time; later membership changes never alter past deliveries (by design).
* Attachments are not implemented (the project had none before this change).
* The unread count in the sidebar covers broadcasts only; Direct Messages have no unread tracking.
* No message editing/deletion/retention job exists yet.
