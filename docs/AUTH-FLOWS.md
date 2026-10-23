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

## Endpoints

| Endpoint | Body / cookie | Answer |
|---|---|---|
| `POST /api/auth/register` | `{ name, email, password }` | `201 { token, expiresIn, user }` + refresh cookie |
| `POST /api/auth/login` | `{ email, password }` | `200 { token, expiresIn, user }` + refresh cookie |
| `POST /api/auth/sso` | `{ code, code_verifier }` | `200 { token, expiresIn, user }` + refresh cookie |
| `POST /api/auth/refresh` | refresh cookie | `200 { token, expiresIn, user }` + rotated cookie, or `401` |
| `POST /api/auth/logout` | refresh cookie | `200 { ok: true }`, family revoked and cookie cleared |
| `GET /api/auth/me` | `Authorization: Bearer` | `200 { user }` |

Rate limiting: the credential endpoints keep the strict limit (20 per 15 minutes per address). `/refresh` and
`/logout` are excluded from it and use a lenient one instead, because the SPA refreshes on every page load and the
preview proxy hides client IPs — a strict per-IP limit there would lock people out of their own session.

## Cookie attributes

`httpOnly`, `Path=/api/auth` (only the auth endpoints ever receive it), `SameSite=None; Secure` when the API's public
origin is HTTPS — the web client and the API are different sites, so a `Lax` cookie would never be sent. Locally
(`http://localhost`) it stays `Lax`, which is same-site and works without TLS. Nothing is hardcoded: the decision comes
from `SSO_ISSUER`/`CLIENT_URL` and the `x-forwarded-proto` header.

## Tests

```
docker compose -f docker-compose.base44.yml exec -T api sh -c \
  'MONGO_URI_TEST=mongodb://mongo:27017 node --test test/auth.session.test.js'
```

Covers: 15-minute token and cookie flags, rotation, replay revoking the family and bumping `sv`, a later rotation
dying with the family, logout revocation, revocation on a security change, and "no cookie means no session".

## Not implemented yet (from the agreed plan)

MFA (TOTP enrolment, recovery codes, mandatory for privileged roles) and a Security page for linked providers and
active sessions are still to come. Google and Facebook already work, but through the campus SSO provider (the
workspace is an OIDC client of `cui-communicate`), not by calling Google directly from the messaging server.
