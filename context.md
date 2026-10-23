# CUI_Communicate — Project Context for AI Assistants

> **Purpose:** This file is the hand-off brief for another LLM or developer. Read it before changing code. Treat the current source code and `docs/SRS_final.md` as the source of truth; this file summarizes the intent and known state, but may become stale as the project changes.

## 1. Project at a glance

**CUI_Communicate** is a COMSATS University Islamabad communication web application. It has two separate modules:

1. **Direct Messages** — one-to-one conversations with message requests (accept/decline), blocking and relationship rules.
2. **Group broadcasting with personal inboxes** — a sender picks one or more authorized groups and writes a message; the server
   delivers it to each eligible member's **own inbox**. There is no shared group chat.

Live updates use Socket.IO; MongoDB delivery records are the source of truth.

### Product goals

- Authorized one-to-one conversations and one-to-many broadcasts with a clean, responsive, accessible interface.
- Deliver new DMs and broadcasts in real time, with unread counts, in-app notifications and optional browser notifications.
- Official groups (`Everyone`, campus, department, class, functional) follow institutional hierarchy; informal groups
  (`Project_Team`, `Study_Group`…) use the **same** delivery model, with invitation-based consent.
- Automatically enroll accounts in the default groups matching their university/campus/department scope **when the account
  is created or changes scope**, not when a page happens to load.
- Preserve server-side authorization, institutional scope boundaries and audit behavior.

### Important distinction about the current code

The standalone Announcement module, the old group chat REST route (`GET /groups/:id/messages`) and the group Socket.IO events
(`group:join`, `group:message`) were **removed**. Legacy group `messages` and the `announcements` collection remain in existing
databases untouched and unread (see `docs/MIGRATION.md`). Details of the new design: `docs/BROADCASTING.md`.

## 2. Technology stack

- **Frontend:** React 18, Vite, JavaScript/JSX, `socket.io-client`, `lucide-react`, CSS.
- **Backend:** Node.js (ES modules), Express, Socket.IO.
- **Database:** MongoDB with Mongoose.
- **Authentication:** JWT (`jsonwebtoken`, HS256) and `bcryptjs` password hashing.
- **Security helpers:** central policy functions, scoped role assignments, security version checks, audit logging, rate limiting.

There are no TypeScript requirements in the current codebase. Follow the existing JavaScript/JSX conventions unless the user explicitly requests a migration.

## 3. Repository map

```text
CUI_Communicate/
├── context.md                       # This hand-off document
├── AGENTS.md                        # Guidance for coding agents / LLMs
├── README.md                        # Setup, overview, API/events, seed notes
├── package.json                     # Root convenience scripts
├── docs/
│   ├── SRS_final.md                 # Main requirements specification
│   ├── AUTHORIZATION-MATRIX.md      # Role/scope/capability reference
│   ├── BROADCASTING.md              # Broadcast/inbox design, API and socket events
│   └── MIGRATION.md                 # Migrating an existing database
├── SEEDING.md                       # Demo data and idempotency
├── client/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── App.jsx                  # App shell, navigation, direct messages, administration
│       ├── broadcast.jsx            # Inbox hook + Inbox, Compose, Groups, group-management UI
│       ├── styles.css               # Visual system and responsive styles
│       └── main.jsx                 # React entry point
└── server/
    ├── package.json
    ├── .env.example
    ├── src/
    │   ├── index.js                 # Express + Socket.IO setup/event handlers
    │   ├── seed.js                  # Idempotent demo users, official + informal groups
    │   ├── migrate.js               # `npm run migrate` (idempotent, non-destructive)
    │   ├── models/index.js          # Mongoose schemas/models
    │   ├── middleware/auth.js       # REST authentication middleware
    │   ├── routes/auth.js           # Register/login/session routes
    │   ├── routes/api.js            # REST routes: users, DMs, groups, management
    │   ├── routes/broadcasts.js     # Broadcast send, inbox, read state, audiences
    │   └── services/
    │       ├── policy.js            # Central role/scope/DM/broadcast policy
    │       ├── broadcast.js         # Audience calculation, idempotent persistence, recovery
    │       ├── enrollment.js        # Default-group auto-enrollment
    │       ├── migration.js         # Legacy-to-broadcast migration
    │       └── realtime.js          # Notifying active, current-version sockets
    └── test/
        ├── authorization.test.js          # Policy unit tests (no database)
        └── broadcast.integration.test.js  # HTTP + Socket.IO tests (need MONGO_URI_TEST)
```

## 4. Run locally

Requirements: Node.js 20+ recommended and a running local MongoDB or MongoDB Atlas database.

### Backend (Windows PowerShell/CMD)

```powershell
cd server
copy .env.example .env
```

Edit `server/.env` and set `JWT_SECRET` to a random secret of **at least 32 characters**. Set `MONGO_URI` for your database if it is not the local default. Then run:

```powershell
npm install
npm run seed
npm run dev
```

The API normally runs at `http://localhost:5000`.

### Frontend

Open a second terminal:

```powershell
cd client
copy .env.example .env
npm install
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`.

### Root convenience scripts

From the repository root, `npm install` installs the root development dependency, `npm run install:all` installs the server/client dependencies, and `npm run dev` starts both processes using `concurrently`.

### Demo seed warning

The seed script is for a **development/demo database only**. It resets passwords for its known demo accounts and replaces membership/permission data for its named demo groups. Never run it against production or real university data without reviewing its operations first.

Example seeded logins (password defaults to `Demo@12345`, configurable with `DEMO_PASSWORD` before seeding):

- `Technical_Admin_1@comsats.edu.pk`
- `Rector_1@comsats.edu.pk`
- `Incharge_1@comsats.edu.pk`
- `HOD_1@comsats.edu.pk`
- `Coordinator_1@comsats.edu.pk`
- `Faculty_1@comsats.edu.pk`
- `Student_1@comsats.edu.pk`
- `Student_2@comsats.edu.pk`
- `Employee_1@comsats.edu.pk`

These are fictional demo accounts. Self-registration must not grant institutional roles.

## 5. Role and authorization model

The eight roles defined in `server/src/models/index.js` and the SRS are:

1. Technical Admin
2. Rector
3. Campus Incharge
4. HOD
5. Department Coordinator
6. Teacher
7. Student
8. Employee account

A user can have a primary role plus additional active scoped assignments. Authorization must use the active role/assignment and matching scope; a role name alone is not enough to bypass policy.

Key constraints:

- Technical Admin is for technical/security/account-recovery operations. It has **no automatic** institutional management, group-policy override, official publishing, or private-message-content access.
- Rector authority is university-scoped; Campus Incharge authority is campus-scoped; HOD/Department Coordinator authority is department-scoped unless a separate explicit assignment grants a different scope.
- Campus, department, class/course, and functional scope boundaries must be enforced on the backend.
- Membership, posting, publishing, ownership, delegation, and history access are separate permissions.
- Never trust client-supplied role names, recipient lists, group IDs, campus/department values, or membership claims without checking the database and policy helpers.
- Role/status/scope/assignment changes must invalidate or re-evaluate existing sessions and communication relationships.
- Private conversations are participant-only. Administrative roles do not automatically gain private message history access.

Read `docs/AUTHORIZATION-MATRIX.md` for the detailed capability matrix and `docs/SRS_final.md` for the full requirements and acceptance criteria.

## 6. Data model overview

The current Mongoose models exported from `server/src/models/index.js` are:

- **User:** identity, email/password hash, primary role, campus, department, active assignments, account status, avatar color, last-seen time, and `securityVersion`.
- **Conversation:** participants, pending/accepted/declined request state, sender/recipient resubmission state, blocks, relationship snapshot, embedded messages, and last-message timestamp.
- **Group:** an audience — name/description/scope, owner, members, membership history, join requests, invitations, `removedUsers`, `autoEnroll`, managers/delegations, visibility, posting policy/roles, publishers, archive status. (Legacy embedded `messages` are deprecated, unselected and unused.)
- **Broadcast:** one logical group message (sender, body, audience-group snapshot, idempotency key, status, recipient count).
- **Delivery:** one inbox entry per recipient (`broadcast`, `recipient`, `via` groups, `readAt`); unique per (broadcast, recipient).
- **AuditLog:** security and administrative action metadata.

Direct messages are embedded in their `Conversation` (sender, body, timestamp, `readBy`). Broadcast bodies are stored once in `Broadcast`; each recipient's entry is a `Delivery`. Persisted `_id` values make client updates duplicate-safe.

## 7. Groups and automatic membership

Groups are **audiences**. Official default groups (flagged `autoEnroll`): `Everyone` (all active accounts),
`IslamabadCampus` and `IslamabadCampus_ComputerScience_Department` (accounts whose profile matches). Others: class (`BCS_6A`),
functional (`CS_Faculty`, `Student_Help_Desk`) and informal groups.

* Enrollment (`services/enrollment.js`) runs at registration, account creation, user/assignment changes and login, and
  `GET /groups` is only a safety net. Users manually removed are recorded in `removedUsers` and not re-added.
* Informal groups: the owner *invites*; the person joins on accepting. Visibility `private` / `approval` / `open`.
* Discoverability never exposes content. A removed member stops receiving future broadcasts but keeps what was delivered.

## 8. Real-time communication with Socket.IO

The browser opens one authenticated socket (JWT in `auth.token`, automatic reconnection). Each socket joins only its personal
room `user:<id>`; there are **no group rooms**.

### Client-to-server events

- `conversation:join` — open a DM room (participants only).
- `message:send` — send a direct message (server checks policy, persists, then delivers).
- `typing:set` — transient typing status for an eligible DM.

(Broadcasts are **sent over REST** — `POST /api/broadcasts` — so the response is the delivery acknowledgement.)

### Server-to-client events

- `message:new` — persisted direct message.
- `broadcast:new` — a delivery for this recipient (payload in `docs/BROADCASTING.md`).
- `broadcast:read` / `broadcast:receipt` / `broadcast:sent` — read-state sync across tabs; author's read count; author's send ack.
- `notification:new` — generic notification (no message body).
- `presence:snapshot`, `presence:changed`, `typing:changed`.

### Real-time invariants

1. Authenticate at the handshake; check active account status and `securityVersion`.
2. Persist before notifying; MongoDB deliveries are the source of truth, sockets are best-effort.
3. Emit only to sockets whose `securityVersion` still matches (revoked sessions receive nothing).
4. De-duplicate on the client by delivery/message `_id`; on every (re)connect re-synchronize the inbox and unread count via REST.
5. Never trust client-provided recipients; never emit protected content to shared rooms.
6. Multiple tabs: each receives the event once; closing one tab must not mark the user offline while another is connected.

## 9. REST API quick reference

Full broadcast contract: `docs/BROADCASTING.md`.

- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- Users: `GET /api/users?q=...`
- Direct messages: `GET /api/conversations`, `POST /api/conversations/request`, `POST /api/conversations/:id/decision`, block/unblock
- Broadcasts: `GET /api/broadcasts/audiences`, `POST /api/broadcasts/preview`, `POST /api/broadcasts`, `GET /api/broadcasts/inbox`, `/sent`, `/unread-count`, `/thread/:groupId` (per-user group conversation), `/:id`, `POST /:id/read`, `POST /thread/:groupId/read`, `POST /read-all`
- Groups: `GET /api/groups`, `GET /api/groups/creatable`, `POST /api/groups` (informal, or official if the caller holds `groups:create:<level>`), `POST /api/groups/:id/join`, `/leave`, `GET /api/groups/invitations`, `POST /api/groups/:id/invitations/respond`, `PATCH /api/groups/:id/settings`, `GET|PATCH /api/groups/:id/senders` (owner chooses who can send)
- Group posting policy (official): `GET /api/admin/groups`, `PATCH /api/admin/groups/:id/permissions`
- Management: `GET/POST/PATCH /api/management/users…`, `GET /api/management/groups`, `PATCH /api/management/groups/:id/members`
- Health: `GET /api/health` (no authentication)

Removed: `GET /api/groups/:id/messages` and all `/api/announcements…` routes.

## 10. Quality and validation status

```bash
cd server && npm install && npm test                                   # policy unit tests; integration tests are SKIPPED without a database
MONGO_URI_TEST=mongodb://127.0.0.1:27017 npm test                      # + 21 HTTP/Socket.IO integration tests (throw-away database)
cd ../client && npm install && npm run build
```

State of verification when this change was made: policy unit tests, the integration suite and the client build were run
against a **FerretDB 1.24 (MongoDB-compatible) server**, not against a real MongoDB; a browser end-to-end pass (Playwright)
covered the inbox, compose, groups, invitations and mobile flow. Re-run the suite against your own MongoDB before trusting it.
Not covered by any automated test: browser notifications, load/scale (large audiences), and real devices.

## 11. Recommended workflow for the next LLM

Before editing:

1. Read this file, `README.md`, `docs/SRS_final.md`, and `docs/AUTHORIZATION-MATRIX.md`.
2. Inspect the actual source files involved; do not assume this summary fully describes current behavior.
3. Find all call sites and event handlers for any feature being changed. For communication features, check both REST and Socket.IO paths.
4. Keep security checks on the server. Client-side controls improve UX but are not authorization.
5. Preserve existing requirements unless the user explicitly changes them.
6. Do not rewrite the whole application for a targeted bug fix.
7. After changes, run syntax checks, relevant tests, and archive-integrity checks when a ZIP is produced. Report exactly what was and was not tested.
8. If a seed script changes, ensure repeated runs are idempotent, do not clear live messages unintentionally, and do not use conflicting MongoDB update operators on the same path.

### Suggested first prompt for another LLM

> Read `context.md`, `AGENTS.md`, `README.md`, `docs/SRS_final.md`, and `docs/AUTHORIZATION-MATRIX.md` before making changes. Inspect the actual source code and summarize the current architecture and any mismatches between requirements and implementation. Do not modify files until you identify the relevant code paths and propose a focused plan. Keep Direct Messages separate, groups as audiences with individual inboxes, live Socket.IO notifications, default scoped groups, and server-side authorization intact. State assumptions and test results honestly.

## 12. Security reminders

- Never commit a real `.env`, JWT secret, real student data, passwords, or production database credentials.
- Replace the example JWT secret before running locally.
- Treat all demo identities and demo passwords as public/test-only.
- Do not log message bodies or private conversation contents in audit/error logs.
- Do not deploy this development project to a university production environment without full security review, data-protection review, load testing, and acceptance testing.
