# Migrating an existing database to group broadcasting

Run once after deploying this version, and again at any time (it is **idempotent and non-destructive**):

```bash
cd server
npm run migrate
```

`npm run seed` runs the same migration first, so seeding an older development database also migrates it.

## What it does

1. **Renames legacy chat-room groups** to audience names *only when the new name is free*:
   `General Announcements → Everyone`, `Campus Announcements → IslamabadCampus`,
   `Department Announcements → IslamabadCampus_ComputerScience_Department`, `BCS-6A Class Group → BCS_6A`,
   `Faculty Coordination → CS_Faculty`, `Student Help Desk → Student_Help_Desk`.
2. **Tightens posting rules** on those groups (they were chat rooms where every role could post; broadcasting is one-to-many).
   Posting roles become Rector (Everyone), Rector + Campus Incharge (campus), plus HOD/Coordinator (department), etc.
   Administrators can adjust them on *Group permissions*.
3. Marks the three default groups `autoEnroll` and **enrolls every active account** in the ones matching its scope.
4. Builds indexes for `Broadcast`, `Delivery`, `Group`, `User`.

## What it never does

* It does **not** delete or rewrite old group messages (`groups.messages`) or the legacy `announcements` collection.
  They remain in MongoDB for audit/export but no route reads them, and they are **not** converted into broadcasts
  (nobody gains access to history that was never delivered to them).
* It does not touch users, passwords, assignments, direct conversations or audit logs.
* It does not drop collections.

## Official-group creation permissions

Officials can now create official groups at every level within their authority, using scoped `groups:create:<level>`
permissions on their assignment (`university`, `campus`, `department`, `class`, `functional`). `npm run seed` grants the
sensible defaults to the demo officials. **Existing deployments are not changed automatically** (the migration never grants
privileges): until an administrator who already holds a permission delegates it (User administration → assignments), an
official keeps only the creation rights they had before, and informal groups remain available to everyone.

## Things to check after migrating

* Informal groups created before this version keep their old `postingPolicy`. Owners can change it under *Groups → Manage*.
  Members of old informal groups stay members; **new** members must accept an invitation.
* Removals from default groups are only remembered from this version on. Someone who left a default group *before* migrating
  is treated as a normal eligible account and is re-enrolled; remove them again afterwards if that is not wanted.
* To export legacy group history before ever pruning it:
  `mongosh <db> --eval 'db.groups.find({}, {name:1, messages:1}).forEach(printjson)'`.

## Rollback

The old chat endpoints were removed from the code, so rolling back means deploying the previous version. Data written by this
version (`broadcasts`, `deliveries`, new `groups` fields) is ignored by the previous version and can be left in place.
