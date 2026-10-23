# Software Requirements Specification (SRS)

## COMSATS University Communication System

> **Revision note:** Sections 8.5, 8.6 and 9 were rewritten when the project moved from group chat rooms and a separate announcement module to **group broadcasting with individual inboxes**. Where other sections still mention announcements or group conversations, sections 8.5, 8.6 and 9 and `docs/BROADCASTING.md` take precedence. Direct-message rules (section 7) are unchanged.

**Institution:** COMSATS University Islamabad (COMSATS)  
**Document version:** 2.0  
**Status:** Final — based on the agreed architecture decisions  
**Primary technology:** React, Node.js, Express.js, Socket.IO, MongoDB, JWT, bcrypt

---

## 1. Purpose

The COMSATS University Communication System provides secure, real-time communication among university users across campuses, academic departments, and administrative or operational offices. It supports direct conversations, message requests, controlled groups, official announcements, comments, read receipts, notifications, and auditable authorization.

This specification separates three concepts that must not be conflated:

1. **Organizational structure:** where a person is assigned and their formal reporting or working relationships.
2. **Roles and permissions:** what actions a person may perform and the organizational scope in which they may perform them.
3. **Communication policy:** who may contact whom, which groups and announcements a user may access, and which actions are permitted in each channel.

The system is for communication only. It does **not** implement an application submission, application approval, or application-routing workflow.

## 2. Scope

### 2.1 In scope

- Authentication and user account management.
- Campus, department, and organizational assignment management.
- Role and scoped-permission management.
- One-to-one conversations and message requests.
- Group creation, discovery, membership, messaging, and history access.
- Official announcements and announcement discussions.
- Individual announcement read receipts.
- Real-time delivery, notifications, typing indicators, online/offline status, and message status.
- Auditing of permission changes, publishing actions, comment edits/deletions, moderation, and group lifecycle changes.
- Server-side authorization for HTTP APIs, Socket.IO events and rooms, notifications, attachments, and history retrieval.

### 2.2 Out of scope

- Application submission, approval, or routing workflows.
- Voice/video calls, screen sharing, or end-to-end encryption in the initial version.
- Fee, attendance, payroll, examination-management, or other ERP workflows.
- Unrestricted administrator access to private messages.

## 3. Core architecture principles

1. **Default deny:** an action is permitted only when an explicit policy or valid scoped permission allows it.
2. **Server-side enforcement:** frontend visibility is not authorization. Every protected API and Socket.IO action must be checked on the server.
3. **Least privilege:** permissions are limited to the smallest valid organizational scope.
4. **Separate technical and institutional authority:** technical administration does not automatically grant authority to publish university notices, manage institutional roles, or read private conversations.
5. **Relationship-aware messaging:** direct-message eligibility is based on approved relationships and explicit role/scope rules, with message requests used when no direct-message rule applies.
6. **Reevaluation:** role, campus, department, enrollment, assignment, membership, and delegation changes must trigger authorization reevaluation.
7. **Auditable administration:** sensitive authorization and content-management actions are logged.
8. **No implicit privilege inheritance:** membership, group ownership, publisher status, and accepting a message request each grant only the permissions explicitly associated with that action.

## 4. Organizational structure and assignments

### 4.1 Organizational entities

The system shall support:

- The university and university-level offices.
- Multiple campuses.
- Academic departments.
- Functional and administrative departments such as Examinations, Accounts/Finance, Security, Administration, IT/Network, HR, Library, Student Affairs, Transport, and Maintenance.
- Courses, classes, committees, functional teams, and other approved communication units where needed.

A department is not necessarily academic. Department types are configurable by authorized university personnel.

### 4.2 Assignment model

Each user has:

- One primary role.
- One primary organizational assignment, where applicable.
- Optional additional roles or assignments for specific responsibilities.
- Explicit scope for each additional role or assignment.

An additional assignment grants only the permissions attached to that assignment and its scope. It can be revoked independently. Staff remain valid user accounts; the system must not create an “Other Staff” authorization role merely to represent users without a coordinator title.

### 4.3 Organizational structure versus authority

The system may represent formal reporting lines such as Rector, Campus Incharge, HOD, and Department Coordinator, but reporting hierarchy alone must not silently grant every system permission. Each management, communication, and publishing action must be explicitly associated with a role and scope.

Cross-department functional relationships may be configured where the university needs them. A functional office such as IT, HR, Accounts, or Examinations does not receive unrestricted access to other departments merely because it serves them.

## 5. Roles and responsibility boundaries

### 5.1 Supported role types

The initial role model includes:

- **Technical Admin** — technical operation, system configuration, account recovery, security response, and technical maintenance.
- **Rector** — university-level institutional authority within explicitly assigned permissions.
- **Campus Incharge** — institutional authority within the assigned campus and explicitly delegated scope.
- **Head of Department (HOD)** — authority within the assigned department and explicitly delegated scope.
- **Department Coordinator (DC)** — coordination and management permissions explicitly granted within the assigned department.
- **Teacher** — academic user with teaching, course, class, or other explicitly assigned relationships.
- **Student** — student user with campus, department, course, class, and group assignments as applicable.
- **Employee account** — identity category for staff/employee users. Employee accounts receive permissions through scoped assignments, not through a broad “Other Staff” role.

The roles **Departmental Staff Coordinator (DSC)** and **Campus Staff Coordinator** are not part of the role model. The system must not require them for staff communication.

### 5.2 Technical Admin limits

Technical Admin may manage technical settings, account lifecycle operations, security controls, system health, and technical recovery. Technical Admin does not automatically receive:

- Access to private-message content or private conversation history.
- Rector, campus, or department institutional authority.
- Official announcement publishing permissions.
- Permission to override organizational communication policy.

Exceptional access to protected content, if ever required by formally approved university policy, must use separate authorization, a defined purpose, limited duration, and audit logging. It must not be a permanent implicit Technical Admin privilege.

### 5.3 Split governance

University-authorized officials manage organizational roles, assignments, and communication permissions within their authorized scope. Technical Admin manages technical operation. Changes that cross institutional and technical boundaries must be separately authorized and logged.

## 6. Permission model

### 6.1 Permission dimensions

Authorization decisions shall consider, as applicable:

- Actor and target user.
- Actor's role and active scoped assignments.
- Campus, department, class/course, team, or other organizational scope.
- Existing communication relationship.
- Message-request state and blocking/restriction state.
- Group type, membership, membership period, and delegated permissions.
- Announcement scope, audience, and publisher authorization.
- Account status and university-wide safety restrictions.

### 6.2 Separate capabilities

The system must treat these as distinct permissions:

- Start a direct conversation.
- Send a message request.
- Accept or decline a request.
- Send messages in an accepted conversation.
- Create a group.
- Join or request to join a group.
- Add or remove group members.
- View current or historical group messages.
- Post in a group.
- Publish an official announcement.
- Comment or reply on an announcement.
- Moderate comments.
- View individual read receipts.
- Pin/unpin content (not supported for announcements in this version).
- Manage or delegate group permissions.
- Change organizational assignments or roles.

A permission in one category does not imply permissions in another category.

## 7. Direct messaging and message requests

### 7.1 General rule

Direct messaging follows a **hybrid policy**. A direct conversation may be initiated without a request only when an approved relationship or explicit role-and-scope rule permits it. Otherwise, the sender must use a message request, unless university policy explicitly prohibits the contact. Authentication alone does not make all direct messaging immediately available.

### 7.2 Message-request eligibility

Any authenticated university user may send a message request to any other authenticated university user, regardless of campus, department, or role, subject to:

- Account suspension or deactivation.
- Blocking or other applicable safety restrictions.
- University-wide restrictions.
- The recipient-controlled rule for resubmitting after a declined request.

A request does not guarantee acceptance or establish an organizational relationship.

### 7.3 Request preview and rate of contact

A pending request exposes the sender identity and one initial message to the recipient. The sender cannot send additional messages through that request until it is accepted. The system must prevent repeated messages from bypassing the pending-request limit.

### 7.4 Declined requests and blocks

After a recipient declines a request, the sender cannot submit another request unless the recipient permits resubmission. Blocking is separate from declining and prevents ordinary requests and messages between the blocked users according to university policy.

### 7.5 Accepted requests

When a request is accepted, both users may freely message each other in that conversation, subject to blocking, account status, and university-wide safety restrictions. Acceptance does not grant group membership, publishing rights, organizational authority, or access to any other conversation.

### 7.6 Messaging relationship rules

The following rules define baseline direct-message eligibility. A stricter block, safety restriction, account restriction, or explicit university policy takes precedence.

| Sender | Recipient | Direct message without request |
|---|---|---|
| Student | Assigned teacher or explicitly authorized academic contact | Allowed |
| Student | Authorized university office whose defined audience includes the student | Allowed through the approved office/contact relationship |
| Student | Another student in an eligible shared class/course | Allowed |
| Student | Another student in an eligible group, where group policy explicitly permits this relationship | Allowed |
| Student | Other student or employee without an eligible relationship | Message request required |
| Teacher | Assigned students and explicitly authorized academic relationships (e.g. supervision/advising) | Allowed |
| Teacher | Other students without an eligible relationship | Message request required unless a separate university-approved functional permission applies |
| HOD | Any student in the HOD's assigned department | Allowed |
| Department Coordinator | Any student in the coordinator's assigned department | Allowed |
| Campus Incharge | Any student assigned to that campus | Allowed |
| Rector | Any student across all university campuses | Allowed |
| Employee | Colleagues within the employee's own department or valid reporting chain | Allowed |
| Employee | Employees outside that department/reporting chain | Message request required unless an explicitly approved cross-department rule applies |
| Employee | Student without an explicitly authorized relationship or university function | Message request required |

Department membership alone does not automatically authorize an employee to message students directly. Functional-office contact rules must define the office's audience and authorized representatives.

### 7.7 Student-to-leadership asymmetry

Officials may initiate direct conversations with students within their approved scope. Students must use a message request unless an existing relationship or designated contact channel permits direct messaging. This access is intentionally asymmetric and must not be converted into automatic reciprocity.

### 7.8 Relationship and assignment changes

When a role, department, campus, course, class, or other qualifying relationship changes, the system must reevaluate whether an existing direct conversation remains eligible for direct messaging. Conversation history is preserved according to policy. If neither user has a currently eligible relationship or authorization, further messages require a new request. Prior acceptance is not permanent authorization.

## 8. Group model

### 8.1 Group types

The system shall support:

- **Discussion groups:** members can post according to membership and group rules.
- **Announcement groups:** only authorized publishers can post official notices.
- **Mixed groups:** authorized publishers issue official notices, while ordinary members can discuss under the group's rules.

Groups may be university-wide, campus-level, department-level, class/course-based, functional-team, committee, or informal/personal groups.

### 8.2 Group creation

Official or restricted groups can be created by roles authorized for the relevant scope, or by explicitly delegated creators. Examples include an HOD creating an authorized department group, a Campus Incharge creating a campus group, or a teacher creating an assigned course group when permitted.

Eligible users may create informal/personal groups, subject to university policy, safety restrictions, and group-type limits. Creation rights do not grant access beyond the creator's authority.

### 8.3 Membership management

- Official/restricted groups: authorized owners/managers control membership within their approved scope.
- Informal/personal groups: the owner may add or remove members within policy.
- Class/course groups: membership follows valid academic assignment or enrollment data.
- Sensitive groups: membership may be invitation-only or require an approval request.
- Group owners and managers cannot override blocks, safety restrictions, or university rules.

### 8.4 Joining and discovery

Joining policy depends on group type. Controlled groups may require an invitation, an eligibility check, or an approved membership request. A group being discoverable does not make its messages or history public.

Informal groups may use one of these owner-selected visibility modes:

1. Private/invite-only.
2. Discoverable with approval.
3. Discoverable and open to eligible users.

Official/restricted group visibility is controlled by university policy and authorized institutional roles.

### 8.5 Group posting (revised: broadcasting)

Groups are **audiences, not chat rooms**. A member never posts into a shared timeline. Sending a message to a group is a *broadcast*: the sender selects one or more groups, the server verifies that the sender may broadcast to each, calculates the eligible recipients from current membership, account status and scope, and delivers one entry per recipient to that person's personal inbox (a user in several selected groups receives one entry).

- **Official groups:** broadcast authority comes from an institutional assignment covering the group's scope with the `broadcast:send` permission (Rector, Campus Incharge, HOD, and Department Coordinators to whom the HOD delegates it), or from a member's role being listed in the group's posting roles (for example Teachers in `CS_Faculty`, `BCS_6A`). Technical Admin never qualifies by role.
- **Informal groups:** the owner may broadcast; other members only if the owner's posting policy allows. Informal groups grant no institutional authority, and people join them only by accepting an invitation.

- **Owner-chosen senders:** the owner of any group may allow or stop individual current, eligible members from sending to it. This never widens institutional rules: Technical Admin cannot be chosen, and the owner cannot change an official group's permitted roles.

Group membership or ownership does not automatically grant broadcast authority. Creating, viewing, joining, managing membership, broadcasting and reading are separate permissions. Details: `docs/BROADCASTING.md`.

### 8.6 Historical access after membership ends

Access to a broadcast is determined by the recipient's own delivery record, not by current group membership. The group conversation screen shows each person only the messages delivered to them through that group plus those they sent, so it never exposes history that was not delivered to the viewer. A user keeps the messages that were delivered to them; removal from a group prevents all future deliveries; and a user who joins later never sees broadcasts that were not delivered to them. The system cannot revoke screenshots or copies made outside the application.

### 8.7 Ownership, managers, and delegation

Each group has one primary owner and may have authorized managers. The owner may grant specific management capabilities only within the owner's own authority and group scope. Examples include membership management, settings, moderation, publisher management, announcement permissions, pin/unpin where applicable to the group, and ownership succession actions.

Manager status alone does not permit appointing further managers. Sub-delegation is allowed only when explicitly authorized. Delegation records must identify the delegator, delegate, capabilities, scope, and time. If the delegator loses authorization, dependent delegations must be reevaluated and revoked when no longer valid. Privilege escalation is prohibited and server-side checks are mandatory.

### 8.8 Ownership succession

If an owner leaves or loses eligibility, the system shall:

1. Promote an eligible existing manager according to a predefined, explicit succession priority.
2. If no manager qualifies, evaluate eligible ordinary members using an explicit succession priority.
3. Verify each candidate's group and organizational scope before transfer.
4. If no candidate qualifies, flag the group for authorized intervention rather than granting unauthorized authority.
5. Record the transfer in the audit log and reevaluate delegated permissions.

### 8.9 Group deletion, archive, and restoration

For informal groups, an eligible owner may remove the group from active use. Official/restricted groups require authorization appropriate to their scope. The system must distinguish removing a group from active use from permanent erasure.

When a group is removed from active use:

- It disappears from active group lists and discovery.
- New messages are disabled.
- Group management and publishing permissions are deactivated.
- Authorized users retain historical access under the group's history and retention rules.
- Official records are preserved according to applicable retention requirements.
- The action is audited.

Restoration requires authorization appropriate to the group type and scope. Before reactivation, the system must revalidate the owner, managers, delegations, and membership eligibility. Restoration is audited.

### 8.10 Group-change notifications

Notify relevant members/publishers about major changes such as ownership transfer, visibility changes, removal from active use/restoration, posting-policy changes, and announcement-publishing permission changes. Routine member additions/removals and routine administration updates use quieter notifications by default. Notifications must not expose sensitive security or administrative details. Mandatory security/access notices remain enforceable where policy requires them.

## 9. Group broadcasting and personal inboxes (replaces the former "Official announcements" module)

The standalone announcement module (publishing lifecycle, comments, edit history) is **removed**. University-wide and scoped notices are ordinary broadcasts to the relevant official groups (`Everyone`, a campus group, a department group, a class group) by authorized senders.

### 9.1 Sending
A sender composes a message, selects one or more permitted groups, and submits it with a client-generated idempotency key. The server validates authority for every selected group, computes the recipient set at send time, persists one logical broadcast and one delivery per recipient, and notifies recipients in real time. A retry with the same key never creates duplicates.

### 9.2 Inbox and read state
Selecting a message opens the conversation of its group: a chat-style history of that user's own deliveries and sent messages, with a reply box when the user may send. Each user has a personal inbox with sender, role, time, audience labels, read/unread state, unread count, search and filtering. Opening a message marks it read for that user only. Senders see a "Sent" view with delivery and read **counts** (never who read it).

### 9.3 Delivery and recovery
MongoDB delivery records are authoritative; Socket.IO is a live channel. Clients re-synchronize the inbox and unread count after reconnecting. Interrupted sends are completed by retry or startup recovery.

### 9.4 Audit and retention
Broadcast sends and authorization denials are written to the audit log without message content. Legacy announcement and group-chat data is retained unmodified for audit/export but is not exposed (see `docs/MIGRATION.md`). Attachments, message editing/deletion and an automated retention job are not implemented.

## 10. Notifications and presence

The system shall support real-time notifications for new direct messages, message requests, group messages, announcement publication, eligible announcement comments/replies, and relevant group changes. Notifications must not reveal message or announcement content to users who are not authorized to access that content.

The system may display online/offline status, typing indicators, and delivery/read status where applicable. These signals must not bypass conversation or group access controls.

## 11. Data requirements

The implementation should use data models equivalent to the following logical entities. Exact collection names may vary.

### 11.1 User and assignments

- User identity and account status.
- Primary role and primary organizational assignment.
- Additional scoped roles/assignments and their validity periods.
- Campus and department references where applicable.
- Account creation/deactivation timestamps and audit metadata.

### 11.2 Organization

- Campus.
- Department and department type.
- Academic course/class or other assignment structures where used for communication eligibility.
- Organizational relationships and explicit cross-functional authorization records.

### 11.3 Direct conversations

- Conversation participants.
- Request state: pending, accepted, declined, or other defined terminal state.
- Sender and one-message preview for pending requests.
- Request acceptance/decline timestamps.
- Recipient-controlled permission to resubmit after decline.
- Block/restriction state as a separate control.
- Message records, timestamps, delivery/read metadata, and retention metadata.

### 11.4 Groups

- Group type, scope, owner, managers, visibility, posting policy, and active/archived state.
- Membership records with start/end times and eligibility evidence where needed.
- Explicit manager/delegation permissions and delegation lineage.
- Succession priority and transfer records.
- Messages and history-access entitlements.

### 11.5 Announcements and discussions

- Announcement content, publisher, scope, immutable audience definition, publish timestamp, and current content version.
- Audit records for edits without exposing a version history in the normal interface.
- Individual view receipts and authorized access logs.
- Comments and threaded replies.
- Comment edit/deletion audit events and deleted-comment placeholders.
- Moderation actions.

### 11.6 Audit records

Audit records should include actor, action, affected resource, applicable scope, timestamp, outcome, and relevant before/after permission metadata. Sensitive message content must not be copied into general-purpose audit logs unless explicitly required by an approved policy.

## 12. Functional requirements

### Authentication and organization

- **FR-01 Authentication:** The system shall authenticate registered users with valid credentials.
- **FR-02 Account lifecycle:** Authorized users shall create, update, deactivate, and recover accounts according to their assigned scope.
- **FR-03 Role assignment:** Only university-authorized officials may assign institutional roles and scoped permissions within their authority.
- **FR-04 Organization management:** Authorized users shall manage campuses, departments, department types, and assignments within scope.
- **FR-05 Multiple assignments:** The system shall support one primary role/assignment and additional scoped assignments.
- **FR-06 Revocation:** Role/assignment changes shall revoke permissions derived from the changed assignment while preserving permissions supported by other valid assignments.

### Direct communication

- **FR-07 Message requests:** Any authenticated user may send one initial message as a request to another authenticated user, subject to safety restrictions.
- **FR-08 Request gating:** A sender may not send additional messages through a pending request until it is accepted.
- **FR-09 Request decisions:** Recipients may accept or decline requests; resubmission after decline requires recipient permission.
- **FR-10 Conversation messaging:** Accepted conversations permit two-way messaging subject to blocks, account status, and university-wide restrictions.
- **FR-11 Relationship policy:** The server shall apply the approved role, scope, and relationship matrix before permitting direct-message initiation.
- **FR-12 Reassessment:** Changes to role, assignment, class/course, or qualifying relationship shall trigger direct-message eligibility reevaluation.

### Groups

- **FR-13 Group creation:** Group creation shall be limited by group type, role, scope, and explicit delegation.
- **FR-14 Membership:** Membership changes shall be authorized according to group type and scope.
- **FR-15 Joining:** Group joining, discovery, invitations, and membership requests shall follow group policy.
- **FR-16 Posting:** Group posting permissions shall be separate from membership and ownership where required.
- **FR-17 History:** Historical message access shall respect membership periods and prior access entitlements.
- **FR-18 Delegation:** Group delegation shall be explicit, scoped, auditable, and checked for privilege escalation.
- **FR-19 Succession:** The system shall apply the predefined group ownership succession process.
- **FR-20 Lifecycle:** Removing a group from active use shall disable new messages while preserving authorized history; restoration requires revalidation and audit.

### Announcements

- **FR-21 Publishing:** The system shall permit immediate manual publication only for authorized publishers.
- **FR-22 Scope:** University-wide, campus-wide, and department-wide publishing shall enforce explicit scope rules.
- **FR-23 Immutable audience:** An announcement audience shall not change after publication.
- **FR-24 No withdrawal/deletion:** Published announcements and discussions shall not be withdrawn or deleted.
- **FR-25 Editing:** Authorized publishers may edit within scope; the current version replaces the previous version in the normal interface and edits are audited.
- **FR-26 Chronological feed:** Announcements shall be shown in chronological order without pinning.
- **FR-27 Comments:** All eligible recipients may comment and reply; announcement discussions cannot be locked.
- **FR-28 Comment controls:** Users may edit/delete their own comments and replies; deleted parent comments retain a placeholder and their replies.
- **FR-29 Moderation:** Authorized moderators may moderate comments/replies within scope, with audit records.
- **FR-30 Read receipts:** Authorized publishers/officials may view individual announcement read receipts within scope; there is no formal acknowledgment feature.

### Real-time operation and audit

- **FR-31 Real-time delivery:** The system shall deliver authorized messages and notifications in real time.
- **FR-32 Socket.IO authorization:** The server shall authorize every room join and protected event; possession of a room identifier is not sufficient.
- **FR-33 History access:** Message and announcement history retrieval shall be checked against current permissions and applicable historical entitlements.
- **FR-34 Audit:** Sensitive permission, delegation, group lifecycle, publishing, editing, read-receipt access, and moderation actions shall be logged.
- **FR-35 Notifications:** Notifications shall respect current access rights and shall not leak protected content.

## 13. Role and communication summary matrix

| Capability | Technical Admin | Rector | Campus Incharge | HOD | DC | Teacher | Student | Employee account |
|---|---|---|---|---|---|---|---|---|
| Technical configuration/security | Yes, technical scope | No by default | No by default | No by default | No by default | No | No | No |
| Institutional role/assignment management | No by default | Explicit university scope | Explicit campus scope | Explicit department scope if delegated | Explicit department scope if delegated | No by default | No | No by default |
| University-wide announcement publishing | No by default | Yes | Only if separately authorized | Only if separately authorized | Only if separately authorized | Only if separately authorized | No by default | Only if separately authorized |
| Campus-wide announcement publishing | No by default | If authorized | Yes within campus | Only if separately authorized | Only if separately authorized | Only if separately authorized | No by default | Only if separately authorized |
| Department-wide announcement publishing | No by default | If authorized | If authorized | Yes within department | If authorized | If authorized | No by default | If authorized |
| Direct message to any student in scope | No automatic privilege | All campuses | Assigned campus | Assigned department | Assigned department | Assigned/authorized academic relationships | Not applicable | Only explicit relationship/function |
| Direct message to any other user | No automatic privilege | Per policy and scope | Per policy and scope | Per policy and scope | Per policy and scope | Per policy and scope | Request unless eligible | Request unless eligible |
| Private-message content access for administration | No by default | No automatic access | No automatic access | No automatic access | No automatic access | Own conversations only | Own conversations only | Own conversations only |

This matrix is a summary. The detailed permission policy and explicit scoped assignments take precedence over a broad role label.

## 14. Socket.IO and API security requirements

1. Authenticate socket connections using a valid session/JWT and validate account status.
2. Authorize every join to a private conversation or group room on the server.
3. Authorize every send, edit, delete, moderation, membership, publishing, and history event independently.
4. Never trust client-supplied role names, scope IDs, recipient lists, membership claims, or publisher claims without server-side verification.
5. Recheck authorization after relevant role, assignment, membership, or block changes; remove revoked sockets from rooms where required.
6. Apply the same policy to REST APIs, Socket.IO events, notifications, attachments, message search, and history retrieval.
7. Ensure room names and identifiers do not themselves expose protected content.
8. Use rate limits and abuse controls for message requests, authentication, and repeated failed authorization attempts.
9. Record security-relevant authorization failures and administrative changes without logging unnecessary private content.

## 15. Non-functional requirements

- **Security:** Passwords shall be hashed using bcrypt or an approved equivalent. JWT/session handling, input validation, authorization, and secret management must follow secure implementation practices.
- **Performance:** Real-time messaging should feel responsive under the expected project workload. Specific throughput and latency targets should be measured and documented during implementation testing.
- **Reliability:** Persist messages and important state changes; handle reconnects and transient Socket.IO disconnections safely.
- **Consistency:** Authorization decisions must be consistent across REST and Socket.IO paths.
- **Maintainability:** Keep role policy, scope evaluation, and communication rules centralized rather than duplicating business rules across routes and UI components.
- **Auditability:** Audit records must be protected against ordinary-user modification and available only to authorized personnel.
- **Usability:** The interface should make pending requests, accepted conversations, group scope, announcement audience, and permission-related failures understandable.
- **Privacy:** Only users authorized by current policy may retrieve private content, read receipts, group history, or restricted announcement discussions.

## 16. Error handling

The system shall return clear, non-sensitive errors for:

- Invalid credentials or expired sessions.
- Inactive/suspended accounts.
- Unauthorized direct-message initiation.
- Pending or declined message requests.
- Blocked communication.
- Unauthorized group access or posting.
- Ineligible group membership or management actions.
- Unauthorized announcement publication, editing, moderation, or read-receipt access.
- Attempted audience changes, withdrawal, deletion, or pinning of a published announcement.
- Invalid or revoked delegation.

Error messages must not disclose protected users, groups, messages, or internal security details beyond what the requester is authorized to know.

## 17. Acceptance criteria

The system is acceptable when tests demonstrate that:

1. Organizational hierarchy, roles, permissions, and communication policy are represented separately.
2. Technical Admin does not automatically gain private-message access or institutional publishing rights.
3. Users have one primary role/assignment and may receive additional scoped assignments.
4. Any eligible authenticated user can send a one-message request, while blocks and safety restrictions are enforced.
5. A pending request prevents further messages until acceptance.
6. A declined request cannot be resubmitted without recipient permission.
7. Accepting a request grants only two-way messaging in that conversation.
8. Direct-message eligibility follows the agreed role, relationship, and scope matrix.
9. Role or assignment changes trigger permission reevaluation and revocation.
10. Group membership, posting, ownership, delegation, and history access are separately authorized.
11. Group owner succession cannot promote an ineligible user or grant unauthorized scope.
12. Removing a group from active use prevents new messages but preserves authorized history; restoration revalidates access.
13. Announcement publishers are restricted by explicit university/campus/department scope.
14. Announcements publish manually, display chronologically, and cannot be pinned, withdrawn, deleted, or have their audience changed after publication.
15. Authorized publishers can edit announcements; the current version replaces the previous one in the normal interface and edits are audited.
16. Eligible recipients can comment and reply; announcement discussions cannot be locked.
17. Users can edit/delete their own comments; deleted parent comments leave a placeholder and replies remain.
18. Individual announcement read receipts are visible only to authorized officials within scope, and access is audited.
19. No formal announcement acknowledgment feature exists.
20. REST APIs, Socket.IO events, rooms, notifications, attachments, and history retrieval enforce the same server-side authorization rules.
21. Sensitive administrative actions are audited and ordinary users cannot alter audit records.

## 18. Technology stack

- **Frontend:** React.
- **Backend:** Node.js and Express.js.
- **Real-time communication:** Socket.IO.
- **Database:** MongoDB.
- **Authentication:** JWT/session-based authentication as appropriate to deployment.
- **Password storage:** bcrypt.

The stack does not replace the need for explicit policy design, server-side authorization, auditability, and automated tests.

## 19. Implementation guidance

Implement the authorization policy as centralized services rather than scattered conditionals. Recommended logical services include:

- `OrganizationService` — assignments and organizational relationships.
- `AuthorizationService` — scoped permission evaluation.
- `MessagingPolicyService` — direct-message eligibility, requests, and relationship reevaluation.
- `GroupPolicyService` — group access, posting, membership, history, delegation, and succession.
- `AnnouncementService` — publication, immutable audience, editing, comments, read receipts, and moderation.
- `AuditService` — append-only or tamper-resistant audit events.
- `NotificationService` — authorization-aware notification delivery.

The exact module names are implementation suggestions, not additional user-facing roles. Policy tests should cover allowed and denied cases for each role/scope combination, including revoked permissions and cross-campus/cross-department attempts.

## 20. Conclusion

The COMSATS University Communication System shall provide secure and auditable communication across university campuses, departments, and functions. Its key design rule is that organizational assignment, role permissions, and communication eligibility are distinct but coordinated. Direct messaging uses explicit relationships and message requests; groups use scope-aware membership and delegation; official announcements use immutable audiences, immediate publication, chronological display, comments, individual read receipts, and preservation after publication. All access control is enforced server-side and reevaluated when the user's valid assignments or permissions change.
