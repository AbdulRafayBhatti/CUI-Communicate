# Multi-Tenant Single Sign-On (SSO)

This repository contains two products that share one Express server and one React client:

1. **CUI_Communicate** — the university messaging workspace (Direct Messages + group broadcasting). Unchanged.
2. **The SSO platform** (`server/src/sso/`) — a multi-tenant OAuth 2.0 / OpenID Connect provider with MFA,
   token management, social sign-in and an administration dashboard, plus two sample client applications.

The SSO platform keeps its own collections (`sso_*`), its own users and its own RS256 signing keys, so adding it
cannot change the messaging authorization model. The messaging app keeps using its own JWT login.

## Sample client applications

| Application | URL (sandbox) | Client ID |
|---|---|---|
| Campus Portal | `https://9101-$BASE44_PUBLIC_HOST_SUFFIX` | `campus-portal` |
| Library Desk | `https://9102-$BASE44_PUBLIC_HOST_SUFFIX` | `library-desk` |

Both are dependency-free Node apps in `demo-clients/`. They redirect to the provider, exchange the code **server side**
(client secret + PKCE verifier), verify the `id_token` RS256 signature against `/jwks`, keep their own session cookie
and expose a protected API (`GET /api/me`, `GET /api/courses`, `GET /api/loans`) that answers `401` without a session.

Open one, sign in, then open the other: the provider session is reused, so no credentials are requested again — that is
the single sign-on demonstration required by the assignment.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/openid-configuration` | Discovery document (issuer, endpoints, PKCE S256, RS256) |
| `GET /jwks` | Public signing key (RS256) |
| `GET /oauth/authorize` | Authorization endpoint — validates client, exact redirect URI, scopes, PKCE; enforces MFA policy |
| `POST /oauth/token` | `authorization_code` (client secret + PKCE) and `refresh_token` grants |
| `GET /oauth/userinfo` | Bearer-token claims |
| `POST /oauth/introspect` | Token introspection (client-authenticated) |
| `POST /oauth/revoke` | Refresh-token revocation (revokes the whole rotation family) |
| `GET /login`, `POST /login` | The centralized sign-in page every registered application redirects to |
| `GET/POST /mfa`, `GET/POST /mfa/enroll`, `POST /mfa/disable` | TOTP verification, enrolment with recovery codes, disable |
| `GET/POST /forgot`, `GET/POST /reset` | Password recovery (single-use links, session revocation) |
| `GET /account` | Account management: profile, password change, active sessions, linked providers |
| `GET /logout` | Session termination (optionally redirecting to a registered `post_logout_redirect_uri`) |
| `GET /sso/oauth/:provider/start`, `/callback` | Google and Facebook authorization-code flows |
| `GET /admin`, `/admin/tenants`, `/admin/tenant`, `/admin/audit` | Administration dashboard (see below) |

## Tenancy and administration

* A **platform administrator** manages tenants (create, activate, deactivate) and can open any tenant.
* A **tenant administrator** only ever sees their own tenant: users, applications, policies and audit trail.
  Every dashboard query is scoped server-side; a `?tenant=` value from a tenant administrator is ignored.
* Per-tenant policy: MFA mode (`off` / `optional` / `required`), access-token lifetime (300–3600 s), refresh-token
  lifetime, session lifetime, minimum password length, lockout threshold and duration, and Google/Facebook enablement
  with per-tenant client credentials.
* Applications are registered per tenant (client type, exact redirect URIs, enable/disable). The client secret is shown
  once on registration and stored hashed.

## Tokens, MFA and password security

* Access tokens and `id_token`s are **RS256** JWTs carrying `iss`, `aud`, `sub`, `tenant`, `scope`, `sid`, `amr`, `exp`.
* Refresh tokens are random opaque values, stored as SHA-256 hashes, and **rotate on every use**. Replaying an
  already-rotated token revokes the entire family and records `token.reuse_detected` in the audit log.
* Passwords are hashed with **bcrypt** (cost 12) and validated against the tenant's minimum length plus a
  three-character-class rule; common passwords are rejected.
* Repeated failed sign-ins increment a counter and lock the account for the tenant's lockout window; failed attempts are
  also throttled per client address. An administrator can unlock an account or reset its second factor.
* TOTP is RFC 6238 (SHA-1, 30 s, 6 digits, ±1 step tolerance). Enrolment issues **10 single-use recovery codes**
  (stored hashed). When a tenant sets MFA to `required`, `GET /oauth/authorize` sends users to enrolment/verification
  before any authorization code is issued.
* Provider sessions are `HttpOnly`, `SameSite=Lax` cookies (marked `Secure` when the issuer is HTTPS); all POST forms
  carry CSRF tokens, and cross-tenant authorization attempts are refused and audited.
* Google and Facebook flows are fully implemented (state, nonce, PKCE for Google, code exchange, userinfo, secure
  linking that refuses to relink an account to a different identity of the same provider). **They need real client
  credentials**: enable the provider in *Administration → Identity providers* and paste the client ID/secret, or the
  button shows a "not configured" page. In the Base44 sandbox the same two pairs of values can also arrive from the
  environment (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET`, delivered
  through `/run/base44/app.env`): the SSO seed copies them into the demo tenant while its provider slots are still
  empty, never overwriting credentials saved in the dashboard and never switching a provider on. Nothing is hardcoded
  and no real credentials are committed.

## Demo data

Created by `npm run seed:sso` (idempotent; also run automatically on API start):

| Account | Password | Role |
|---|---|---|
| `sso_admin@comsats.edu.pk` | `Demo@12345` | Platform administrator (all tenants) |
| `tenant_admin@comsats.edu.pk` | `Demo@12345` | Tenant administrator (COMSATS) |
| `student@comsats.edu.pk` | `Demo@12345` | Member (COMSATS) |

Tenants: `COMSATS University Islamabad` (`comsats`, active) and `North Campus Institute` (`north-campus`, for isolation tests).
Passwords are only set when an account is first created, so a seed run never resets anything you changed.

## Assignment coverage

| Requirement | Where it is implemented |
|---|---|
| A. Centralized auth, register/sign-in/sign-out, SSO session, OAuth2/OIDC, RBAC, redirect to central login | `/login`, `/oauth/authorize`, `/account`, `/logout`, roles `platform_admin` / `tenant_admin` / `member` |
| B. Multi-tenancy, per-tenant dashboard, isolated users/apps/config, registering client apps | `sso_tenants`, `sso_client_apps`, `/admin/*` scoped by tenant |
| C. MFA toggles, TOTP, enrolment, verification, recovery codes, recovery procedure | tenant `settings.mfa`, `/mfa*`, `security.js` (TOTP, recovery codes), admin `reset-mfa` |
| D. Hashing, no plaintext, strength rules, failed-attempt protection, reset/change password | bcrypt cost 12, `passwordProblems`, lockout counters, `/forgot`, `/reset`, `/account/password` |
| E. Short-lived access tokens, refresh + rotation + revocation, claim validation, logout, HTTPS-ready | `tokens.js`, `POST /oauth/token`, `/oauth/revoke`, `/logout`, `Secure` cookies |
| F. Google and Facebook login, tenant toggles, secure linking, failure/callback handling | `/sso/oauth/:provider/*`, tenant provider settings, linking rules (credentials are placeholders) |
| G. Two sample client applications, cross-app session, protected routes/APIs, new app registration | `demo-clients/campus-portal`, `demo-clients/library-desk`, `/admin/tenant/apps` |
| Administrative dashboard | `/admin` (overview, tenants, tenant settings, users, applications, audit trail, failed sign-ins) |
| Non-functional: security, isolation, scalability, maintainability, usability, reliability | scoped queries, schema-clamped lifetimes, modular `server/src/sso/*`, responsive pages, explicit error pages |

## Verifying

```bash
# stack
docker compose -f docker-compose.base44.yml up -d
curl -s http://localhost:8000/.well-known/openid-configuration | head -c 200
# sample clients (open in a browser)
open http://localhost:9101/ ; open http://localhost:9102/
# provider login and dashboard
open http://localhost:8000/login ; open http://localhost:8000/docs
```

Development affordances worth knowing:

* With no mail transport configured, `POST /forgot` shows the single-use reset link in the page instead of emailing it.
  Set `SSO_SHOW_RESET_LINKS=false` to hide it.
* The sample client secrets in `docker-compose.base44.yml` are development placeholders shared with the demo apps.
