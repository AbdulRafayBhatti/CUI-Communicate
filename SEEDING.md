# Seeding development data

> **Development/demo databases only.** The seed resets the password of each demo account to the demo password and refreshes
> the named demo groups. Never run it against real university data.

```bash
cd server
cp .env.example .env     # set MONGO_URI and a JWT_SECRET of 32+ characters
npm install
npm run seed
```

Demo password for every account: `Demo@12345` (override with `DEMO_PASSWORD` in `server/.env` before seeding).

## Accounts

`Technical_Admin_1`, `Rector_1`, `Incharge_1`, `HOD_1`, `Coordinator_1`, `Faculty_1`, `Student_1`, `Student_2`, `Employee_1`
(all `@comsats.edu.pk`). Rector, Incharge and HOD carry the scoped `broadcast:send` permission and may create official groups within their authority (Rector: all levels; Incharge: campus/department/class/team of their campus; HOD: department/class/team of their department). The Department Coordinator has **no** default broadcast right; the HOD can delegate it (covered by a test).

## Groups

| Group | Kind | Members | Who may message it |
|---|---|---|---|
| `Everyone` | official, university, auto-enroll | all 9 | Rector |
| `IslamabadCampus` | official, campus, auto-enroll | all but Technical Admin | Rector, Campus Incharge |
| `IslamabadCampus_ComputerScience_Department` | official, department, auto-enroll | all but Technical Admin | Rector, Incharge, HOD |
| `CS_Faculty` | official, functional | HOD, Coordinator, Faculty | HOD, Coordinator, Teacher |
| `BCS_6A` | official, class | Faculty, Student_1, Student_2 | Rector, Incharge, HOD, Teacher |
| `Student_Help_Desk` | official, functional | Coordinator, Faculty, both students | Coordinator, Teacher |
| `Project_Team` | informal, private | Student_1 (owner), Student_2 | any member |
| `Study_Group` | informal, open | Student_2 (owner) | owner |

## Idempotency

Running the seed repeatedly creates no duplicate users, groups or members. It **adds only missing members**, never
re-adds anyone removed from a group, and never touches broadcasts, deliveries or direct conversations. It uses `updateOne`
(`upsert`) with a single operator per field path, so there are no MongoDB path conflicts. Tested twice-over in
`broadcast.integration.test.js` ("Seeding twice is idempotent…").
