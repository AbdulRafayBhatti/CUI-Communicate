# Instructions for AI Coding Agents

1. Read `context.md`, `README.md`, `docs/SRS_final.md`, `docs/AUTHORIZATION-MATRIX.md` and `docs/BROADCASTING.md` before changing code.
2. Inspect current source files; documentation may lag implementation.
3. Product direction: **Direct Messages** (one-to-one, request/accept/decline/block) and **Group broadcasting with individual inboxes**. **Groups are audiences, not chat rooms**: never reintroduce a *shared* group timeline (an endpoint or socket room that reads or streams a group's messages to members as a group), `group:join`/`group:message` socket events, or a separate announcements module. The **group conversation screen** is allowed because it is a *per-user* view: `GET /broadcasts/thread/:groupId` is built only from the caller's own delivery records plus what they sent, so a member who joined later still sees nothing earlier. University/campus/department notices are ordinary broadcasts to the `Everyone` / campus / department groups.
4. Keep REST and Socket.IO authorization consistent by using the central policy in `server/src/services/policy.js` (`canBroadcastToGroup`, `isEligibleForGroup`, DM helpers). Validate identity, account status, `securityVersion`, membership, assignments and scope on the server for every protected action. Never trust client-supplied recipients, roles or scope.
5. Never grant institutional privileges from a role label or from the Technical Admin role alone. Official-group broadcast authority needs an assignment covering the scope **and** the scoped `broadcast:send` permission (or an explicit `postingRoles` entry for members). Follow `docs/AUTHORIZATION-MATRIX.md`.
6. Persist before delivering. Delivery records in MongoDB are the source of truth; Socket.IO is best-effort. Keep notification payloads free of message bodies. Sends must stay idempotent on `(sender, clientMessageId)`.
7. Preserve message/delivery IDs and de-duplicate client updates. Test reconnects, multiple tabs and unauthorized access attempts.
8. Seed and migration scripts must stay idempotent and non-destructive: never clear message history, deliveries or legacy data, never re-add users who were removed, and avoid MongoDB update conflicts (one operator per path). Never delete `server/src/seed.js`.
9. Make targeted changes instead of rewriting unrelated modules. Keep the JavaScript/JSX stack and conventions.
10. Run syntax checks, the build and tests after edits. Integration tests need MongoDB: `MONGO_URI_TEST=mongodb://127.0.0.1:27017 npm test` (without it they are reported as **skipped / NOT RUN**, never as passed). Say exactly what was and was not run.
11. Never commit secrets, real personal data or `.env` files. Do not deploy without security and acceptance review.

## Base44 sandbox dev environment (`docker-compose.base44.yml`)

The whole stack runs from this checkout with live reload — no application image is built or pulled:

```bash
docker compose -f docker-compose.base44.yml up -d                   # mongo + api + web
docker compose -f docker-compose.base44.yml logs -f web              # dev-server output
docker compose -f docker-compose.base44.yml exec api npm run seed    # re-seed demo data (idempotent)
```

- Web entry point is host port **3000** (Vite dev server on 5173 inside the container); the API is on host port **8000**
  (`GET /api/health` is its health endpoint). The `api` and `web` services have healthchecks; `seed` runs once after `api` is healthy.
- `web` gets `VITE_API_URL` and `api` gets `CLIENT_URL` from `${BASE44_PUBLIC_HOST_SUFFIX}`, so the browser calls the API
  cross-origin (session is a JWT in `Authorization`, not a cookie). Never hardcode those hosts — always reference the variable.
- `JWT_SECRET` (32+ characters) is required at boot and comes from the platform-managed secrets file `/run/base44/app.env`,
  listed as the last `env_file:`. The current value is a generated development placeholder (flagged in the Base44 dashboard) —
  replace it with a real secret for any real deployment. `server/.env` and `client/.env` are gitignored and are **not** used
  inside the containers (dotenv does not override process environment variables).
- Dependencies install at container start (`npm ci`) into `server/node_modules` / `client/node_modules` (both gitignored).
- The API applies migrations and seeds the demo data itself on its first start against an empty database. The seed is
  guarded (it only runs while the `users` collection is empty) so a restart never repeats it and never resets accounts
  that were changed in the UI; because of that there is no separate one-shot container. Re-seed by hand with
  `docker compose -f docker-compose.base44.yml exec api npm run seed`.
- `client/vite.config.js` is part of this setup: it registers `@vitejs/plugin-react` (fast refresh) and, **only when
  `BASE44_PREVIEW_MODE=1`**, allows the preview proxy host (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` plus
  `.${BASE44_SANDBOX_HOST_DOMAIN}`). With the flag unset, Vite's default host checking is unchanged.
- Seeded demo accounts (password `Demo@12345`) are the quickest way to try the app, e.g. `Student_1@comsats.edu.pk`,
  `Rector_1@comsats.edu.pk`, `Technical_Admin_1@comsats.edu.pk`; the full list is in `SEEDING.md`.

Verification used to accept this environment: `curl http://localhost:3000/` (the dev server serves live source modules,
not a prebuilt bundle), `curl http://localhost:8000/api/health`, and a browser pass signing in as `Student_1@comsats.edu.pk`
that loaded Messages, Compose message, Message requests and Groups with no console errors.

## Multi-tenant SSO platform (`server/src/sso/`, `demo-clients/`)

1. The OIDC provider is mounted at the server root (`app.use(ssoRouter)` in `server/src/index.js`): `/oauth/*`, `/login`,
   `/mfa*`, `/account`, `/forgot`, `/reset`, `/logout`, `/sso/oauth/{google,facebook}/*`, `/admin/*`, `/.well-known/…`,
   `/jwks`, `/docs`. It owns only the `sso_*` collections and must never read or write the messaging models.
2. `SSO_ISSUER` (compose passes `https://8000-${BASE44_PUBLIC_HOST_SUFFIX}`) is the issuer used in `iss`, in the
   discovery document and for social callbacks — never hardcode it. `initSso()` loads or generates the RS256 keypair in
   `sso_signing_keys`, so issued tokens are verifiable through `/jwks`.
3. The SSO router parses `application/x-www-form-urlencoded` itself (no new dependency) and uses double-submit/session
   CSRF tokens; the messaging API stays JSON-only and untouched.
4. Sign-in throttling skips successful requests on purpose (`skipSuccessfulRequests`); the precise control is the
   per-account lockout from the tenant policy. The preview proxy hides client IPs, so keep per-IP limits lenient.
5. `npm run seed:sso` is idempotent and runs on every API start: it creates the demo tenant/accounts/client apps and
   refreshes the client redirect URIs from `DEMO_PORTAL_URL` / `DEMO_LIBRARY_URL`, so a changing preview host cannot
   break the flows. Passwords are set only on first creation — never reset by a seed run.
6. Sample clients live in `demo-clients/campus-portal` (host 9101) and `demo-clients/library-desk` (host 9102): plain
   Node, no dependencies, sharing `demo-clients/shared/oidc.js`.
7. Google and Facebook flows are complete but need real OAuth credentials, which an administrator enters per tenant in
   the dashboard; until then the button shows a "not configured" page. In this sandbox they may also be supplied as
   secrets (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET`): `npm run
   seed:sso` copies them into the demo tenant while its provider slots are still empty — it never overwrites values
   saved in the dashboard and never switches a provider on (enable it in the dashboard afterwards). Never commit
   provider credentials.
8. Verify changes with `MONGO_URI_TEST=mongodb://mongo:27017 npm test`, the SSO end-to-end checks, and a browser pass
   through `9101 → provider login → 9101 → 9102` (the second client must not ask for credentials again).
   Full endpoint list, demo accounts and the assignment mapping: `docs/SSO.md`.
9. The messaging workspace is a registered client too (`cui-communicate`): its login page shows Google/Facebook buttons
   that start the provider's social flow and return to `<web origin>/sso/callback`, where `POST /api/auth/sso`
   exchanges the code (client secret + PKCE) and verifies the RS256 `id_token` against `/jwks` (issuer, audience,
   expiry) before issuing the usual workspace JWT. `MESSAGING_URL` (web origin) and `MESSAGING_CLIENT_SECRET` (a
   development demo value, like the sample clients') are passed by compose; `SSO_CLIENT_ID` defaults to
   `cui-communicate`. The provider still owns only the `sso_*` collections and the workspace never reads them. A first
   sign-in from a campus identity without a workspace account provisions the same unassigned Student account
   self-registration creates. Note when testing: the Base44 preview pane returns to the app's home route when the
   browser leaves for the provider, so complete a Google/Facebook sign-in in a normal browser tab pointed at the web
   origin.
