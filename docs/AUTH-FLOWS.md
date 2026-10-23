# Authentication flows — how a workspace session works

This describes the session layer of **CUI_Communicate** (the messaging workspace in `server/src/routes/auth.js`,
`server/src/services/tokens.js`, `client/src/session.js`). It is deliberately separate from the multi-tenant SSO
provider (`server/src/sso/`), which owns its own `sso_*` collections and its own tokens; the workspace never reads
those models. Google and Facebook sign-in enters the workspace through that provider and ends in exactly the same
session described here.

## The two tokens

| | Access token | Refresh token |
|---|---|---|
| What it is | HS256 JWT `{ sub, sv }` | random 32-byte opaque value |
| Lifetime | 15 minutes | 30 days, rotated on every use |
| Where it lives | client memory only (never localStorage) | `httpOnly` cookie, SHA-256 hash in MongoDB |
| Who can read it | the SPA, for `Authorization: Bearer` | nobody: no JavaScript access, not even the app's |
| Ends with | expiry, or `sv` change | rotation, reuse detection, logout, `sv` change |

`sv` is the account **security version** (`User.securityVersion`). It is carried inside the access token and checked
against MongoDB on every REST and Socket.IO request, exactly as before. Each refresh token also records the `sv` it was
issued under, so a password/role/status change ends the refresh session too — not just the access tokens.

```
                    ┌──────────────────────────┐
                    │  browser (SPA)           │
                    │  access token: memory    │
                    └────────────┬─────────────┘
             Authorization: Bearer│        ▲ httpOnly cookie (cui_refresh, Path=/api/auth)
                                 ▼        │
                    ┌──────────────────────────┐        ┌───────────────────────────┐
                    │  API /api/*              │        │  /api/auth/refresh        │
                    │  requireAuth: sv check   │        │  rotate + reuse detection │
                    └──────────────────────────┘        └─────────────┬─────────────┘
                                                                      ▼
                                                        ┌───────────────────────────┐
                                                        │ RefreshToken collection   │
                                                        │ hash + family + sv + TTL  │
                                                        └───────────────────────────┘
```

## 1. Sign-in (password, registration, or Google/Facebook through the campus provider)

Every sign-in path returns the same shape: a short-lived access token in the body, and the refresh token as a cookie.
The refresh token's value is never sent in a response body.

```
User            SPA                            API                                MongoDB
 │  email+pass   │                              │                                   │
 ├──────────────►│ POST /api/auth/login         │                                   │
 │               ├─────────────────────────────►│ bcrypt.compare                    │
 │               │                              ├───────── verify account ─────────►│
 │               │                              │ new familyId (this device)        │
 │               │                              ├───────── store hash(token) ──────►│
 │               │  200 { token(15m), user }    │                                   │
 │               │  Set-Cookie cui_refresh=…    │                                   │
 │               │◄─────────────────────────────┤                                   │
 │  app loads    │ token → memory (not storage)  │                                   │
```

Registration (`/api/auth/register`, unassigned Student only) and the campus SSO exchange (`/api/auth/sso`, which
verifies the provider's RS256 `id_token` against `/jwks`) end in the same `respondWithSession` call.

## 2. Silent renewal — the SPA never asks the user again

A 401 means the access token expired (or `sv` changed). The client renews once and retries the same request, so an
expired access token is invisible to the user. Overlapping calls share one rotation.

```
SPA                          API
 │ GET /api/conversations     │
 ├───────────────────────────►│  401 (access token expired)
 │◄───────────────────────────┤
 │ POST /api/auth/refresh     │
 │  (cookie: cui_refresh)     │
 ├───────────────────────────►│  mark presented token usedAt
 │                            ├─► issue successor in the SAME family
 │  200 { token }  + new cookie│
 │◄───────────────────────────┤
 │ retry GET /api/conversations (new token)
 ├───────────────────────────►│  200
```

The Socket.IO handshake uses the same access token. On `connect_error` the client renews once, hands the fresh token
to the socket and reconnects; only if renewal fails does it return to the sign-in screen.

## 3. Page load — no session in localStorage

```
load → POST /api/auth/refresh (cookie) ─┬─ 200 → signed in, straight to the workspace
                                        └─ 401 → sign-in screen
```

Nothing session-related is stored in `localStorage` any more, so injected script cannot read a long-lived credential
out of the browser. A refresh token rotates on every page load; the previous value is dead as soon as it is used.

## 4. Reuse detection — what happens if the cookie leaks

A refresh token is single-use. Presenting a value that was already rotated means two parties hold it, so the server
assumes theft: the whole family is revoked **and** the account's `sv` is bumped, which kills every access token
immediately. The thief and the real user are both signed out; only a fresh sign-in works.

```
attacker        API                                  real user
  │ replay old token │                                     │
  ├─────────────────►│ usedAt is set → REUSE DETECTED       │
  │                  ├─ revoke entire family              │
  │                  ├─ User.securityVersion += 1          │
  │  401             │                                     │
  │◄─────────────────┤                                     │
  │                  │                          next request → 401 (sv mismatch)
  │                  │◄────────────────────────────────────┤  sign in again
```

### Known trade-off

Reuse detection is deliberately strict: a used value is refused immediately, with no grace window. That is what makes
a stolen cookie detectable, but it also means two *simultaneous* rotations of the same value look like theft. The
client prevents the common cases — one tab shares a single in-flight rotation (`rotateSession` in `client/src/session.js`)
and cookies are shared between tabs, so a second tab normally refreshes with the latest value. Two tabs refreshing in
the same instant is the remaining case; if it ever shows up in practice, the fix is a short server-side grace window in
which a just-rotated value also gets a successor from the same family.

## 5. Sign-out — real server-side revoke

```
SPA ── POST /api/auth/logout (cookie) ─► revoke family + clear cookie ─► 200
```

The cookie is worthless afterwards (verified by test: a later `/api/auth/refresh` answers 401). Other devices keep
their own families and stay signed in — "revoke all sessions" is what a role/password change does.

## 6. Two-step verification (TOTP)

Privileged roles (`Technical Admin`, `Rector`, `Campus Incharge`, `HOD`, `Department Coordinator`) must carry a
second factor: until one is enrolled, `/api/*` and the Socket.IO handshake refuse the account with
`MFA_ENROLLMENT_REQUIRED`, and the SPA shows the enrolment gate instead of the workspace. Every other role may turn
the second factor on or off from the **Security** page.

With a second factor enrolled, the password (or campus SSO) step only proves the first one. Instead of a session the
API answers `{ mfaRequired: true, mfaToken, expiresIn, methods }` — a five-minute, single-purpose JWT
(`purpose: 'mfa'`) that can do nothing but finish this one sign-in — and `/api/auth/mfa/verify` issues the real session.

```
User            SPA                          API                                    MongoDB
 │ email+pass    │                            │                                       │
 ├──────────────►│ POST /api/auth/login       │                                       │
 │               ├───────────────────────────►│ password ok → mfa.enabled?            │
 │               │ 200 {mfaRequired,mfaToken} │ no session and no cookie yet          │
 │               │◄───────────────────────────┤                                       │
 │ 6-digit code  │ POST /api/auth/mfa/verify  │                                       │
 ├──────────────►│ mfaToken + code            │ verifyTotp(afterStep = mfa.lastStep)  │
 │               │                            ├─────── lastStep = step ──────────────►│
 │               │ 200 {token,user} + cookie  │ session issued exactly as in §1       │
 │               │◄───────────────────────────┤                                       │
```

Rules that are easy to break:

1. A TOTP step is **single use** (`mfa.lastStep`): an already-accepted code is refused as a reuse, not as a typo, so
   an observed code cannot be replayed. Recovery codes are bcrypt-hashed and consumed on first use.
2. Five wrong codes lock the second-factor step for 15 minutes per account (`mfa.lockedUntil`), and the answer never
   says which part was wrong. Password failures keep their own separate backoff.
3. The TOTP secret is stored AES-256-GCM encrypted, keyed by `MFA_ENCRYPTION_KEY` when set and otherwise derived from
   `JWT_SECRET`. A value that cannot be decrypted reads as “no usable secret” instead of throwing.
4. Enrolment (`/mfa/setup` → `/mfa/enable`) keeps the candidate secret in `mfa.pendingSecret` for 15 minutes and only
   promotes it once a code from the authenticator app verifies. The ten recovery codes are returned once, at that
   moment; only their hashes are stored.
5. Turning the second factor **off** is a downgrade: it needs a valid code, is refused for roles where MFA is
   mandatory, bumps `securityVersion` and therefore ends every session on every device. Recovering a mandatory-MFA
   account is a Technical Admin's job, not self-service.

## 7. Devices signed in (the Security page)

`GET /api/auth/sessions` lists one entry per refresh-token family — one per signed-in device — newest first, with
`current: true` on the caller's own family. `DELETE /api/auth/sessions/:id` revokes a single family: signing another
device out leaves this one alone, while revoking the current family also clears the cookie. A password, role, status
or second-factor change bumps `securityVersion` and ends every family at once, so no extra endpoint is needed.

The UI lives in `client/src/security.jsx`: `MfaChallenge` is step two of sign-in, `MfaGate` is the mandatory-enrolment
gate shown instead of the workspace, and `SecurityView` is the page itself (second factor, signed-in devices,
sign-in methods), rendered by `client/src/App.jsx` for `page === 'Security'` and opened from the sidebar's
**Security** item.

## Endpoints

| Endpoint | Body / cookie | Answer |
|---|---|---|
| `POST /api/auth/register` | `{ name, email, password }` | `201 { token, expiresIn, user }` + refresh cookie |
| `POST /api/auth/login` | `{ email, password }` | `200 { token, expiresIn, user }` + refresh cookie |
| `POST /api/auth/sso` | `{ code, code_verifier }` | `200 { token, expiresIn, user }` + refresh cookie |
| `POST /api/auth/refresh` | refresh cookie | `200 { token, expiresIn, user }` + rotated cookie, or `401` |
| `POST /api/auth/logout` | refresh cookie | `200 { ok: true }`, family revoked and cookie cleared |
| `GET /api/auth/me` | `Authorization: Bearer` | `200 { user }` |
| `POST /api/auth/mfa/verify` | `{ mfaToken, code }`, or `recovery: true` with a recovery code | `200 { token, expiresIn, user }` + refresh cookie, or `401` |
| `POST /api/auth/mfa/setup` | `Authorization: Bearer` | `200 { secret, otpauth, qr, expiresIn }` — a candidate secret, pending until confirmed |
| `POST /api/auth/mfa/enable` | `{ code }` | `200 { enabled: true, recoveryCodes }` — the codes are shown only here |
| `POST /api/auth/mfa/disable` | `{ code }`, or `recovery: true` | `200 { token, user }` + cookie; every other session ends |
| `GET /api/auth/sessions` | `Authorization: Bearer` | `200 [ { id, userAgent, startedAt, lastUsedAt, current } ]` |
| `DELETE /api/auth/sessions/:id` | `Authorization: Bearer` | `200 { ok, current, message }` |

Rate limiting: the credential endpoints keep the strict limit (20 per 15 minutes per address). `/refresh` and
`/logout` are excluded from it and use a lenient one instead, because the SPA refreshes on every page load and the
preview proxy hides client IPs — a strict per-IP limit there would lock people out of their own session.

## Cookie attributes

`httpOnly`, `Path=/api/auth` (only the auth endpoints ever receive it), `SameSite=None; Secure` when the API's public
origin is HTTPS — the web client and the API are different sites, so a `Lax` cookie would never be sent. Locally
(`http://localhost`) it stays `Lax`, which is same-site and works without TLS. Nothing is hardcoded: the decision comes
from `SSO_ISSUER`/`CLIENT_URL` and the `x-forwarded-proto` header.

## Environment variables

| Variable | Needed by | Notes |
|---|---|---|
| `JWT_SECRET` | the whole session layer | **Required at boot**, 32+ characters. Signs the 15-minute access token and the five-minute MFA challenge token. Rotating it invalidates every access token and every challenge at once; refresh cookies keep working until their next rotation. |
| `MFA_ENCRYPTION_KEY` | TOTP secrets | Optional. AES-256-GCM key for `mfa.secret` / `mfa.pendingSecret`. When it is unset the key is derived from `JWT_SECRET`. Changing either value makes already-stored TOTP secrets undecryptable, which reads as “no usable secret”: affected accounts must enrol again. |
| `CLIENT_URL` / `SSO_ISSUER` | cookie attributes, CORS | Decide whether the refresh cookie is `SameSite=None; Secure` (HTTPS public origin) or `Lax` (local `http://localhost`). Not MFA-specific — see *Cookie attributes* above. |

Both secrets belong in the platform-managed secrets file (`/run/base44/app.env`), never in the repository. Locally the
environment also needs `MONGO_URI`; the compose stack passes it.

## Tests

```
docker compose -f docker-compose.base44.yml exec -T api sh -c \
  'MONGO_URI_TEST=mongodb://mongo:27017 node --test test/auth.session.test.js test/auth.mfa.test.js'
```

`auth.session.test.js` covers the 15-minute token and cookie flags, rotation, replay revoking the family and bumping
`sv`, a later rotation dying with the family, logout revocation, revocation on a security change, and “no cookie means
no session”. `auth.mfa.test.js` covers the second-factor challenge (no session before the code), TOTP and recovery
verification, step reuse, per-account lockout, enrolment, mandatory MFA for privileged roles, single-device sign-out,
and “turning the factor off ends every session”.

## Not implemented yet (from the agreed plan)

Linking *providers* to an account from the workspace Security page. Google and Facebook already sign in through the
campus SSO provider (the workspace is an OIDC client of `cui-communicate`); what the Security page shows for them is
that the method exists, not a per-provider link/unlink control. Nothing else from the security plan is outstanding.
