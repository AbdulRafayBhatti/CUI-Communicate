# CUI_Communicate

A MERN + Socket.IO starter for the COMSATS University Communication System, based on the supplied SRS. It includes a React workspace UI, Express REST API, MongoDB models, JWT authentication, bcrypt password hashing, and authenticated Socket.IO events.

## Requirements
- Node.js 20+ recommended
- MongoDB Community Server running locally, or a MongoDB Atlas connection string

## Run locally (Windows PowerShell or CMD)
1. Extract the `CUI_Communicate.zip` file.
2. Open a terminal in the extracted `CUI_Communicate` folder.
3. Create backend environment settings:
   ```bash
   cd server
   copy .env.example .env
   ```
   Edit `server/.env` and replace the example `JWT_SECRET` with a random secret of at least 32 characters. Set `MONGO_URI` if your MongoDB is not local.
4. Install backend dependencies and start the API:
   ```bash
   npm install
   npm run dev
   ```
   The API runs at `http://localhost:5000`.
5. Open a second terminal in the project root, then install frontend dependencies and start Vite:
   ```bash
   cd client
   copy .env.example .env
   npm install
   npm run dev
   ```
6. Open the URL printed by Vite, normally `http://localhost:5173`.
7. Create a student account. Self-registration intentionally cannot grant institutional roles. An authorized account provisioning workflow is required for Rector, Campus Incharge, HOD, DC, Teacher, Employee, and Technical Admin accounts.

## Root-level convenience
From the project root, `npm install` then `npm run install:all` installs dependencies in both apps. `npm run dev` starts both processes with `concurrently`.

## Included now
- Student self-registration and login (JWT; bcrypt password hashing)
- User directory search
- Direct conversation initiation with a basic role/scope policy and one-message request flow
- Accept/decline request API with recipient-controlled resubmission flag
- Socket.IO authentication, conversation room checks, direct messages, typing events and notifications
- **Group broadcasting with personal inboxes:** compose to one or more authorized groups; each eligible member receives the message in their own inbox (unread counts, search, read state, sent view). Groups are audiences, not chat rooms
- **Group conversation screen:** opening a message shows that group's full history (what was delivered to you through it, plus what you sent) with a reply box. It is built per user, not a shared room
- **Officials (Rector, Campus Incharge, HOD, …) can create official groups within their authority as well as informal ones**; the dialog offers only what the server permits
- Official and informal groups share one delivery model; informal-group members join by accepting an invitation
- **Group owners choose who can send** to their group (Groups → Manage → *Who can send messages*), within institutional guardrails
- Default-group auto-enrollment at account creation/scope change/login
- Central policy helper and audit-log model
- Responsive UI: Inbox / Direct messages, Compose, Groups, live notification dropdown
- Scoped group-posting permission editor for institutional officials with `groups:posting:manage`; Technical Admin has no implicit institutional/group-policy override
- Scope-aware user administration: authorized officials can provision COMSATS email accounts, update role/campus/department/status, and reset passwords
- Group membership administration: add or remove group members with campus/department scope checks and audit records

## Authentication and authorization model
The SRS-aligned role model has eight roles: Technical Admin, Rector, Campus Incharge, HOD, Department Coordinator, Teacher, Student, and Employee account. Technical Admin is limited to technical account recovery/security operations and has no implicit institutional role assignment, official publishing, group-policy override, or private-message history access. Institutional account and group-management capabilities require active scoped assignments. Campus and department boundaries are checked by the backend; the UI is not treated as a security boundary. See `docs/AUTHORIZATION-MATRIX.md` for the detailed role/action matrix.

JWTs use HS256, expire after 12 hours, and carry a security version checked against MongoDB on REST and Socket.IO requests. Password/status/role/scope/assignment changes revoke prior sessions. Self-registration creates only an unassigned Student account. Private conversations are participant-only; group access, posting, and historical membership periods have separate checks.

## Implementation and verification status
The project contains policy helpers and automated authorization tests for core role/scope decisions. Run `npm test` from `server/` after installing dependencies. A live build/integration test still requires installed npm dependencies and a running MongoDB instance. This is a development project and has not been security-audited for production deployment; continue testing all SRS acceptance criteria before university deployment. Never deploy with the example secret.

To try it, run `npm run seed` in `server`, sign in as `Technical_Admin_1@comsats.edu.pk` with `Demo@12345`, then open **User administration** in the sidebar. Select a group in the Group membership panel to inspect or update its members.

## API overview
- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/users?q=...`
- `GET /api/conversations`, `POST /api/conversations/request`, `POST /api/conversations/:id/decision`
- `GET /api/broadcasts/audiences`, `POST /api/broadcasts/preview`, `POST /api/broadcasts`, `GET /api/broadcasts/inbox|sent|unread-count|:id`, `POST /api/broadcasts/:id/read`, `POST /api/broadcasts/read-all` (see `docs/BROADCASTING.md`)
- `GET /api/groups`, `POST /api/groups`, `POST /api/groups/:id/join|leave`, `GET /api/groups/invitations`, `POST /api/groups/:id/invitations/respond`, `PATCH /api/groups/:id/settings`, `GET|PATCH /api/groups/:id/senders`
- `GET /api/admin/groups`, `PATCH /api/admin/groups/:id/permissions` (active scoped `groups:posting:manage` permission required; Technical Admin does not receive this by default)
- `GET /api/management/users?q=...`, `POST /api/management/users`, `PATCH /api/management/users/:id` (role/scope-authorized officials)
- `GET /api/management/groups`, `PATCH /api/management/groups/:id/members` (scope-authorized group membership management)
- `GET /api/health`

Socket events use the JWT in `io(API, { auth: { token } })`. Client events: `conversation:join`, `message:send`, `typing:set`. Server events: `message:new`, `broadcast:new`, `broadcast:read`, `broadcast:receipt`, `broadcast:sent`, `notification:new`, `presence:snapshot`, `presence:changed`, `typing:changed`. Broadcasts are sent over REST; there are no group rooms.

## Demo seed data
See [`SEEDING.md`](SEEDING.md). In short:

```bash
cd server
cp .env.example .env      # set MONGO_URI and a JWT_SECRET of 32+ characters
npm install
npm run seed              # idempotent: also runs the migration
npm run dev
```

Demo login for every seeded account: `Demo@12345` (override with `DEMO_PASSWORD`). **Development databases only** — the seed resets those accounts' passwords. To migrate an existing database without seeding run `npm run migrate` (see [`docs/MIGRATION.md`](docs/MIGRATION.md)).

## Communication model

There are two modules: **Direct Messages** (one-to-one, with requests/blocking) and **Group broadcasting**. Groups are *audiences*: you choose groups in **Compose message**, the server calculates who is eligible, and each person receives the message in **their own Inbox**. There is no shared group timeline and no separate announcement feed — university/campus/department notices are ordinary broadcasts to `Everyone`, `IslamabadCampus`, etc. Informal groups (`Project_Team`…) work the same way. Full design: [`docs/BROADCASTING.md`](docs/BROADCASTING.md).

## Real-time communication (Socket.IO)

One authenticated socket per session (JWT, active account, `securityVersion`), automatic reconnection, one personal room per user. MongoDB `Delivery` records are the source of truth; Socket.IO events are a live convenience that the client de-duplicates by id and re-synchronizes from `GET /api/broadcasts/inbox` on every (re)connect. Notification payloads never include message bodies. Event payloads: `docs/BROADCASTING.md`.

## Tests

```bash
cd server
npm test                                                     # policy unit tests; integration tests are reported SKIPPED (NOT RUN)
MONGO_URI_TEST=mongodb://127.0.0.1:27017 npm test            # also runs the HTTP + Socket.IO integration suite (creates and drops a throw-away database)
cd ../client && npm run build
```

