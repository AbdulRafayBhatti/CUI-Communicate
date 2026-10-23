# CUI_Communicate — SRS-Aligned Authentication & Authorization Matrix

This matrix follows `docs/SRS_final.md`. Authorization is enforced by the backend; React navigation and disabled controls are usability only and never constitute a security boundary.

## Supported roles

The initial system supports exactly eight role types:

1. Technical Admin
2. Rector
3. Campus Incharge
4. HOD
5. Department Coordinator (DC)
6. Teacher
7. Student
8. Employee account

`Campus Staff Coordinator` and `Departmental Staff Coordinator` are intentionally not separate authorization roles. Staff users are represented as `Employee account`; additional duties are modelled as explicit scoped assignments.

## Roles, actions, and limits

| Role | Actions permitted by baseline policy | Restrictions / additional authorization required |
|---|---|---|
| Technical Admin | Technical operation, account recovery, security response, password/status recovery, session revocation | Cannot assign institutional roles, post to official group chats without group membership and posting permission, override group policy, or read private-message history merely because of this role |
| Rector | University-level institutional oversight; university-wide group participation; can manage institutional accounts/assignments when the relevant university-scoped permission is present | Broadcasting and scoped operations outside baseline defaults require an explicit assignment with the matching permission; no automatic private-message access |
| Campus Incharge | Assigned-campus coordination; campus group participation; user/group operations within the campus when the relevant scoped permissions are present | Cannot operate or broadcast across campuses, and cannot message `Everyone`, without an explicit university-scoped assignment and permission; no automatic private-message access |
| HOD | Assigned-department coordination; department group participation; user/group operations within the department when the relevant scoped permissions are present | Cannot manage other departments or assign roles beyond the permitted subordinate roles; no automatic private-message access |
| Department Coordinator | Department coordination and explicitly delegated account/group operations; may manage permitted Teacher, Student, and Employee accounts when `users:manage`/`roles:assign` is granted in scope | Does not inherit HOD authority and has no default broadcast right; the HOD may delegate `broadcast:send` within the department |
| Teacher | Communication with assigned students/academic contacts; participation in eligible class/course groups; course/class group creation when authorized | Cannot create institutional roles or access unrelated students/departments; broadcasting to an official group requires being a member listed in that group's `postingRoles` (e.g. `CS_Faculty`, `BCS_6A`) or an explicit permission |
| Student | Eligible group participation; message requests; direct messages for eligible shared class/course or authorized contact relationships | No institutional administration; no access to groups/history without membership or valid historical entitlement; unrelated contacts require a request |
| Employee account | Eligible colleague communication and assigned functional/reporting duties | No blanket access to students or other departments; functional office access must be explicitly scoped |

## Separate permissions

The backend treats these as separate capabilities. One does not imply another:

- Start a direct conversation / send a message request / accept or decline a request.
- Send messages in an accepted conversation.
- Create a group / join or request to join / add or remove members.
- Read current or historical group messages.
- Post in a group according to its membership and posting policy.
- Comment / edit or delete own comments / moderate comments.
- Manage a group / manage membership / change posting policy / delegate capabilities.
- Assign or revoke institutional roles and scoped permissions.

## Scope rules

- An active university assignment may cover university, campus, department, class, and functional scope.
- A campus assignment is confined to its exact campus and may cover explicitly authorized work within that campus.
- A department assignment is confined to its exact campus and department; it does not grant campus-wide authority.
- A class assignment does not grant department or campus administration.
- A functional assignment is limited to the specified function/scope and does not create unrestricted cross-department access.
- Empty or malformed campus/department assignments do not match arbitrary campuses/departments.
- Additional assignments are evaluated independently. Revoking one assignment must not remove authority still provided by another active assignment.
- Technical Admin is not an institutional role-assignment shortcut.

## Direct messages

- Any authenticated active university user may send one initial message request to another active user, subject to blocking, rate limits, and safety restrictions.
- A pending request allows only the initial message until accepted. A declined request cannot be resubmitted unless the recipient allows it.
- Accepted requests permit two-way communication only in that conversation; they do not grant group membership, broadcast rights, or access to other conversations.
- Rector may initiate direct contact with students university-wide; Campus Incharge with students at the assigned campus; HOD/DC with students in the assigned department.
- Student/teacher direct messaging without a request requires a current eligible shared class/course group or explicit authorized academic relationship.
- Employee-to-employee direct messaging without a request is limited to the same department or an explicit reporting/function relationship. Employee-to-student contact requires an explicit authorized relationship.
- Role, campus, department, assignment, class/course relationship, block, and account-status changes trigger authorization reevaluation. Private history is only available to its participants; Technical Admin and institutional officials receive no blanket access.

## Groups and broadcasting

Groups are **audiences**. There is no shared group chat; a broadcast is delivered to each eligible member's own inbox.

- **Separate permissions:** create a group, view/discover, join/request, manage membership, send a broadcast, manage the group, and read a delivered message are independent. Membership or ownership never implies all of them.
- **Read access** to a broadcast is decided by the recipient's own `Delivery` record (or authorship). Non-recipients (including Technical Admin and officials) get `404`.
- **Official-group broadcast** (`canBroadcastToGroup`): (a) Rector, Campus Incharge, HOD or Department Coordinator whose active assignment covers the group's scope **and** carries `broadcast:send`; or (b) a current member whose role in the group's scope is in the group's `postingRoles`; or (c) a current, eligible member the group's **owner** has chosen as a sender. Technical Admin never qualifies and can never be chosen. A role label alone does not.
- **Scope examples:** Rector → `Everyone`, any campus/department; Campus Incharge → groups of their own campus only (not `Everyone`, not another campus); HOD/Coordinator → groups of their own department only; Teacher → `CS_Faculty` / `BCS_6A` only when listed in that group's `postingRoles` and a member.
- **Group conversation screen:** assembled per user from that user's own delivery records and sent messages. Access is delivery-based: late joiners, outsiders (including Technical Admin and senior officials who were never reached) get `404`; removed members keep their delivered history but cannot send.
- **Creating groups:** anyone with an active account may create an **informal** group. An **official** group (university, campus, department, class, team) may be created only by someone whose assignment carries the scoped `groups:create:<level>` permission **and covers the chosen campus/department**. Defaults in the seed: Rector, every level anywhere; Campus Incharge, campus/department/class/team in their own campus (never university); HOD, department/class/team in their own department; Department Coordinator, department groups in their own department (delegated); Teacher, class groups. Students, employees and Technical Admin cannot create official groups. The server (`canCreateGroup`) decides; `GET /groups/creatable` only reports the result so the UI offers the right choices. Official names are unique, and informal groups may not use an official group's name.
- **Owner-managed senders:** the owner of *any* group (official or informal) can allow or stop individual members from sending to it. The owner cannot choose themselves, non-members, Technical Admin or people outside the group's scope, and cannot change which roles may send in an official group (administrators do that on Group permissions). Owner-only; audited.
- **Informal-group broadcast:** owner always; other members only if the owner set the posting policy to `members` (or `publishers` and they are listed). Owners cannot broadcast to official groups, cannot enroll people without an accepted invitation, and cannot change official posting rules.
- **Recipients** are computed at send time from current membership, active account status and `isEligibleForGroup` (role, campus, department). Removed members, suspended accounts and out-of-scope accounts receive nothing; earlier deliveries remain theirs.
- **Granting `broadcast:send`:** assignment permissions can be granted only by someone who holds the same permission within scope; self-registration and Technical Admin cannot obtain it.
- Default groups auto-enroll matching accounts at account creation/scope change/login; a manual removal is recorded and not undone.
- `GET /groups/:id/messages`, `group:join`, `group:message` and `/announcements` no longer exist.

## Authentication controls

- Passwords are bcrypt-hashed; hashes are excluded from API responses.
- Login and self-registration require a `@comsats.edu.pk` email. Self-registration can create only an unassigned Student account; client-supplied role/campus/department values are ignored.
- Access tokens are HS256 JWTs that expire after 15 minutes and include a security version. REST and Socket.IO verify the algorithm, current account status, and security version against MongoDB. The client keeps the access token in memory only; a rotating single-use refresh token in an httpOnly cookie renews it (see `docs/AUTH-FLOWS.md`).
- A refresh token that is presented twice revokes its whole session family and bumps the security version, ending every access token for that account at once.
- Password, status, role, campus/department, and assignment changes revoke existing sessions by incrementing the security version.
- Authentication and message-request endpoints are rate-limited; socket messaging is rate-limited and content is limited to 5,000 characters.
- Secrets remain in `server/.env`; `JWT_SECRET` must be at least 32 characters and must be changed from the example value.
- Authorization failures and sensitive administration actions are audited without storing unnecessary private message content.

## Verification

Run `npm test` in `server/` after installing dependencies. Tests cover role separation, scope boundaries, role assignment, group posting, group creation, and malformed/cross-campus assignments. Live integration tests require a running MongoDB instance and local npm dependencies.
