// Server-rendered SSO pages: the centralized login page, MFA enrolment/verification, account management,
// password reset and the tenant administration dashboard. Plain HTML keeps the provider dependency-free and
// works identically for every registered client application.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const csrfField = token => `<input type="hidden" name="_csrf" value="${esc(token)}">`;
const noticeBlock = (notice, error) => `${notice ? `<div class="banner ok">${esc(notice)}</div>` : ''}${error ? `<div class="banner err">${esc(error)}</div>` : ''}`;

const STYLE = `
:root{--ink:#12211d;--muted:#5d6f69;--brand:#0b473b;--brand-2:#176b55;--line:#dfe6e3;--bg:#f4f7f6}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 "DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand-2)}
.wrap{max-width:1040px;margin:0 auto;padding:28px 20px 60px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px}
.mark{width:32px;height:32px;border-radius:9px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:0 1px 2px rgba(16,40,34,.04)}
.card+.card{margin-top:18px}
h1{font-size:26px;margin:0 0 6px}
h2{font-size:18px;margin:0 0 14px}
p.sub{color:var(--muted);margin:0 0 18px}
label{display:block;font-weight:600;font-size:13px;margin:14px 0 6px}
input,select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
button{margin-top:18px;background:var(--brand);color:#fff;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:600;cursor:pointer}
button.alt{background:#fff;color:var(--brand);border:1px solid var(--brand)}
button.small{margin:0;padding:7px 12px;font-size:13px;border-radius:8px}
.banner{padding:11px 14px;border-radius:10px;margin:0 0 14px;font-size:14px}
.banner.err{background:#fdeceb;color:#8c2b22;border:1px solid #f4cfcb}
.banner.ok{background:#eaf6f1;color:#0d5b46;border:1px solid #cbe7dc}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.code{background:#0b1f1a;color:#d8f3e8;border-radius:10px;padding:12px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#eef2f1;color:#38473f}
.pill.ok{background:#eaf6f1;color:#0d5b46}
.pill.bad{background:#fdeceb;color:#8c2b22}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.nav a{padding:8px 14px;border-radius:999px;background:#fff;border:1px solid var(--line);text-decoration:none;font-weight:600;font-size:13px}
.nav a.active{background:var(--brand);color:#fff;border-color:var(--brand)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px}
.stat b{display:block;font-size:24px}
.provider{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
.provider a{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:#fff;text-decoration:none;font-weight:600;color:var(--ink)}
.recovery{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;padding:0}
.recovery li{background:#f4f7f6;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-family:ui-monospace,Menlo,monospace}
`;

const shell = ({ title, subtitle, user, body, brand = 'CUI_Communicate SSO', nav = '' }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(brand)}</title><style>${STYLE}</style></head>
<body><div class="wrap">
<div class="top"><div class="brand"><span class="mark">C</span><span>${esc(brand)}</span></div>
<div class="muted">${user ? `${esc(user.name)} · ${esc(user.email)} · <a href="/logout">Sign out</a>` : ''}</div></div>
${nav}${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
${body}
</div></body></html>`;

export const errorPage = ({ title = 'Request could not be completed', message = '' }) => shell({
  title,
  body: `<div class="card"><h1>${esc(title)}</h1><p class="sub">${esc(message)}</p><a href="/account">Back to your account</a></div>`
});

export const loginPage = ({ tenantName, email = '', error = '', notice = '', hidden = {}, showTenantField = false, providers = [], issuer }) => shell({
  title: 'Sign in',
  subtitle: tenantName ? `Sign in once to use every application registered with ${tenantName}.` : 'Central sign-in for every registered application.',
  body: `<div class="card"><h1>${esc(tenantName || 'Single sign-on')}</h1><p class="sub">One account for all registered campus applications.</p>
  ${noticeBlock(notice, error)}
  <form method="post" action="/login">
    ${Object.entries(hidden).map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value ?? '')}">`).join('')}
    ${csrfField(hidden._csrf)}
    <label for="email">University email</label><input id="email" name="email" type="email" required value="${esc(email)}" placeholder="you@comsats.edu.pk">
    ${showTenantField ? '<label for="tenant">Organisation</label><input id="tenant" name="tenant" placeholder="organisation identifier">' : ''}
    <label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
  ${providers.length ? `<p class="sub" style="margin:20px 0 0">Or continue with</p><div class="provider">${providers.map(p => `<a href="/sso/oauth/${esc(p.provider)}/start?return_to=${encodeURIComponent(hidden.return_to || '/account')}${hidden.client_id ? `&client_id=${encodeURIComponent(hidden.client_id)}` : ''}">${esc(p.label)}</a>`).join('')}</div>` : ''}
  <p class="sub" style="margin:18px 0 0"><a href="/forgot">Forgot your password?</a></p>
  </div>`,
  issuer
});

export const mfaPage = ({ attempt = 'totp', error = '', returnTo = '/account', csrf, user }) => shell({
  title: 'Two-factor verification',
  user,
  body: `<div class="card"><h1>Two-factor verification</h1>
  <p class="sub">${attempt === 'recovery' ? 'Enter one of your saved recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>
  ${noticeBlock('', error)}
  <form method="post" action="/mfa">
    ${csrfField(csrf)}
    <input type="hidden" name="attempt" value="${esc(attempt)}">
    <input type="hidden" name="return_to" value="${esc(returnTo)}">
    <label for="code">${attempt === 'recovery' ? 'Recovery code' : 'Verification code'}</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="${attempt === 'recovery' ? 'ABCDE-FGHIJ' : '123456'}">
    <button type="submit">Verify</button>
  </form>
  <p class="sub" style="margin:16px 0 0"><a href="/mfa?attempt=${attempt === 'recovery' ? 'totp' : 'recovery'}&return_to=${encodeURIComponent(returnTo)}">${attempt === 'recovery' ? 'Use an authenticator code instead' : 'Use a recovery code instead'}</a></p>
  </div>`
});

export const enrollPage = ({ secret, otpauth, recoveryCodes = [], returnTo = '/account', csrf, error = '', user, tenantName }) => shell({
  title: 'Set up two-factor authentication',
  user,
  body: `<div class="card"><h1>Set up two-factor authentication</h1>
  <p class="sub">${esc(tenantName || 'Your organisation')} requires a second factor. Add the secret below to your authenticator app (Google Authenticator, 1Password, Authy…), then confirm with a generated code.</p>
  ${noticeBlock('', error)}
  ${recoveryCodes.length ? `<h2>Save your recovery codes</h2><p class="sub">Each code works once if you lose your authenticator device.</p><ul class="recovery">${recoveryCodes.map(code => `<li>${esc(code)}</li>`).join('')}</ul>` : ''}
  <h2>Authenticator secret</h2>
  <div class="code">${esc(secret)}</div>
  <p class="sub mono" style="word-break:break-all">${esc(otpauth)}</p>
  <form method="post" action="/mfa/enroll">
    ${csrfField(csrf)}
    <input type="hidden" name="return_to" value="${esc(returnTo)}">
    <label for="code">Code from your authenticator</label><input id="code" name="code" inputmode="numeric" required placeholder="123456">
    <button type="submit">Confirm and continue</button>
  </form>
  </div>`
});

export const accountPage = ({ user, tenant, sessions = [], csrf, notice = '', error = '', mfaRequired = false, providers = [] }) => shell({
  title: 'Your account',
  user,
  nav: '<div class="nav"><a class="active" href="/account">Your account</a><a href="/docs">Provider endpoints</a>' +
    ((user.role === 'platform_admin' || user.role === 'tenant_admin') ? '<a href="/admin">Administration</a>' : '') + '</div>',
  body: `<div class="card"><h1>Your account</h1><p class="sub">Manage your credentials, second factor and active sessions.</p>
  ${noticeBlock(notice, error)}
  <table><tbody>
    <tr><th>Name</th><td>${esc(user.name)}</td></tr>
    <tr><th>Email</th><td>${esc(user.email)}</td></tr>
    <tr><th>Organisation</th><td>${esc(tenant?.name || 'Platform administration')}</td></tr>
    <tr><th>Role</th><td><span class="pill">${esc(user.role.replace('_', ' '))}</span></td></tr>
    <tr><th>Second factor</th><td>${user.mfa?.enabled ? '<span class="pill ok">TOTP enabled</span>' : `<span class="pill ${mfaRequired ? 'bad' : ''}">${mfaRequired ? 'Required by your organisation' : 'Not enabled'}</span>`}</td></tr>
    <tr><th>Linked sign-in providers</th><td>${user.socialIdentities?.length ? user.socialIdentities.map(i => esc(i.provider)).join(', ') : '<span class="muted">None</span>'}</td></tr>
  </tbody></table>
  <form method="post" action="/account/password">
    ${csrfField(csrf)}
    <div class="row">
      <div><label for="current">Current password</label><input id="current" name="current" type="password" required></div>
      <div><label for="next">New password</label><input id="next" name="next" type="password" required></div>
    </div>
    <button type="submit">Change password</button>
  </form>
  <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
    ${user.mfa?.enabled
      ? '<form method="post" action="/mfa/disable">' + csrfField(csrf) + '<button class="alt small" type="submit">Disable two-factor authentication</button></form>'
      : (mfaRequired ? '' : `<a class="pill" href="/mfa/enroll">Enable two-factor authentication</a>`)}
  </div>
  ${providers.length ? `<div class="provider">${providers.map(p => `<a href="/sso/oauth/${esc(p.provider)}/start?return_to=/account">${esc(p.label)}</a>`).join('')}</div>` : ''}
  </div>
  <div class="card"><h2>Active sessions</h2>
  <table><thead><tr><th>Started</th><th>Device</th><th>Second factor</th><th></th></tr></thead><tbody>
  ${sessions.map(s => `<tr><td class="muted">${esc(new Date(s.createdAt).toISOString().replace('T', ' ').slice(0, 16))}</td><td class="muted">${esc((s.userAgent || 'Unknown device').slice(0, 60))}</td><td>${s.mfaVerifiedAt ? 'verified' : '—'}</td>
  <td><form method="post" action="/account/sessions/revoke">${csrfField(csrf)}<input type="hidden" name="session" value="${esc(s.sessionId)}"><button class="alt small" type="submit">Revoke</button></form></td></tr>`).join('')}
  </tbody></table></div>`
});

export const forgotPage = ({ csrf, notice = '', error = '', resetLink = '' }) => shell({
  title: 'Reset your password',
  body: `<div class="card"><h1>Reset your password</h1><p class="sub">We verify the account exists and issue a single-use reset link.</p>
  ${noticeBlock(notice, error)}
  ${resetLink ? `<p class="sub">Development mode: no mail service is configured, so the reset link is shown here.</p><div class="code"><a href="${esc(resetLink)}">${esc(resetLink)}</a></div>` : ''}
  <form method="post" action="/forgot">${csrfField(csrf)}
    <label for="email">University email</label><input id="email" name="email" type="email" required>
    <button type="submit">Send reset link</button>
  </form>
  <p class="sub" style="margin-top:16px"><a href="/login">Back to sign in</a></p></div>`
});

export const resetPage = ({ csrf, token, error = '' }) => shell({
  title: 'Choose a new password',
  body: `<div class="card"><h1>Choose a new password</h1>${noticeBlock('', error)}
  <form method="post" action="/reset">${csrfField(csrf)}<input type="hidden" name="token" value="${esc(token)}">
    <label for="password">New password</label><input id="password" name="password" type="password" required>
    <label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" required>
    <button type="submit">Set new password</button>
  </form></div>`
});

export const docsPage = ({ issuer, clients = [] }) => shell({
  title: 'SSO provider',
  nav: '<div class="nav"><a class="active" href="/docs">Provider endpoints</a><a href="/account">Your account</a><a href="/admin">Administration</a></div>',
  body: `<div class="card"><h1>OpenID Connect provider</h1><p class="sub">This service is the centralized single sign-on provider. Register an application in the dashboard, then redirect users to the authorization endpoint.</p>
  <table><tbody>
  <tr><th>Issuer</th><td class="mono">${esc(issuer)}</td></tr>
  <tr><th>Discovery</th><td class="mono">${esc(issuer)}/.well-known/openid-configuration</td></tr>
  <tr><th>Authorize</th><td class="mono">${esc(issuer)}/oauth/authorize</td></tr>
  <tr><th>Token</th><td class="mono">${esc(issuer)}/oauth/token</td></tr>
  <tr><th>UserInfo</th><td class="mono">${esc(issuer)}/oauth/userinfo</td></tr>
  <tr><th>JWKS</th><td class="mono">${esc(issuer)}/jwks</td></tr>
  <tr><th>Introspection / Revocation</th><td class="mono">${esc(issuer)}/oauth/introspect · ${esc(issuer)}/oauth/revoke</td></tr>
  </tbody></table>
  <p class="sub" style="margin-top:16px">Authorization-code flow with PKCE, rotating refresh tokens, RS256 id_tokens and per-tenant MFA, provider and lifetime policies.</p>
  </div>
  ${clients.length ? `<div class="card"><h2>Registered demo applications</h2><table><thead><tr><th>Application</th><th>Client ID</th><th>Redirect URI</th></tr></thead><tbody>${clients.map(c => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.clientId)}</td><td class="mono">${esc(c.redirectUris?.[0] || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`
});

export const providerNotConfiguredPage = ({ provider, tenantName }) => shell({
  title: `${provider} sign-in is not configured`,
  body: `<div class="card"><h1>${esc(provider)} sign-in is not configured</h1>
  <p class="sub">${esc(tenantName || 'This organisation')} has not stored ${esc(provider)} OAuth client credentials yet. An administrator can add them under <strong>Administration → Identity providers</strong>; the flow itself is implemented and will start working as soon as the client ID and secret are saved.</p>
  <a href="/login">Back to sign in</a></div>`
});

export const adminOverview = ({ user, tenant, counts, events = [], tenants = [], csrf, notice = '', error = '' }) => {
  const isPlatform = user.role === 'platform_admin';
  return shell({
    title: 'Administration',
    user,
    nav: adminNav({ user, active: 'overview' }),
    body: `<div class="card"><h1>Administration</h1><p class="sub">${isPlatform ? 'Platform-wide view of every tenant, application and authentication event.' : `Security and application settings for ${esc(tenant?.name || '')}.`}</p>
    ${noticeBlock(notice, error)}
    <div class="grid">
      <div class="stat"><span class="muted">Tenants</span><b>${counts.tenants}</b></div>
      <div class="stat"><span class="muted">Users</span><b>${counts.users}</b></div>
      <div class="stat"><span class="muted">Applications</span><b>${counts.apps}</b></div>
      <div class="stat"><span class="muted">Failed sign-ins (7d)</span><b>${counts.failed}</b></div>
      <div class="stat"><span class="muted">Locked accounts</span><b>${counts.locked}</b></div>
      <div class="stat"><span class="muted">Active sessions</span><b>${counts.sessions}</b></div>
    </div></div>
    ${isPlatform && tenants.length ? `<div class="card"><h2>Tenants</h2><table><thead><tr><th>Tenant</th><th>Identifier</th><th>Status</th><th>MFA policy</th><th></th></tr></thead><tbody>
      ${tenants.map(t => `<tr><td>${esc(t.name)}</td><td class="mono">${esc(t.slug)}</td><td><span class="pill ${t.status === 'active' ? 'ok' : 'bad'}">${esc(t.status)}</span></td><td>${esc(t.settings?.mfa || 'off')}</td>
      <td><a href="/admin/tenant?tenant=${esc(t._id)}">Manage</a></td></tr>`).join('')}</tbody></table>
      <p class="sub" style="margin-top:14px"><a href="/admin/tenants">Create or deactivate a tenant</a></p></div>` : ''}
    ${eventsTable({ events, title: 'Recent authentication events' })}`
  });
};

const adminNav = ({ user, active }) => `<div class="nav">
  <a class="${active === 'overview' ? 'active' : ''}" href="/admin">Overview</a>
  <a class="${active === 'tenant' ? 'active' : ''}" href="/admin/tenant">Tenant settings</a>
  ${user.role === 'platform_admin' ? `<a class="${active === 'tenants' ? 'active' : ''}" href="/admin/tenants">Tenants</a>` : ''}
  <a class="${active === 'audit' ? 'active' : ''}" href="/admin/audit">Audit log</a>
  <a href="/account">Your account</a>
</div>`;

export const eventsTable = ({ events = [], title = 'Authentication events' }) => `<div class="card"><h2>${esc(title)}</h2>
<table><thead><tr><th>When</th><th>Event</th><th>Outcome</th><th>Actor</th><th>Detail</th></tr></thead><tbody>
${events.length ? events.map(e => `<tr><td class="muted">${esc(new Date(e.createdAt).toISOString().replace('T', ' ').slice(0, 19))}</td><td class="mono">${esc(e.type)}</td><td><span class="pill ${e.outcome === 'success' ? 'ok' : 'bad'}">${esc(e.outcome)}</span></td><td>${esc(e.actorEmail || '—')}</td><td class="muted">${esc(e.detail || '')}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">No events recorded yet.</td></tr>'}
</tbody></table></div>`;

export const adminTenantsPage = ({ user, tenants = [], csrf, notice = '', error = '' }) => shell({
  title: 'Tenants',
  user,
  nav: adminNav({ user, active: 'tenants' }),
  body: `<div class="card"><h1>Tenants</h1><p class="sub">Each tenant has isolated users, applications, provider credentials and policies.</p>
  ${noticeBlock(notice, error)}
  <table><thead><tr><th>Tenant</th><th>Identifier</th><th>Status</th><th>MFA</th><th>Google / Facebook</th><th></th></tr></thead><tbody>
  ${tenants.map(t => `<tr><td>${esc(t.name)}</td><td class="mono">${esc(t.slug)}</td><td><span class="pill ${t.status === 'active' ? 'ok' : 'bad'}">${esc(t.status)}</span></td><td>${esc(t.settings?.mfa || 'off')}</td>
  <td>${t.settings?.providers?.google?.enabled ? 'yes' : '—'} / ${t.settings?.providers?.facebook?.enabled ? 'yes' : '—'}</td>
  <td><form method="post" action="/admin/tenants/${esc(t._id)}/status">${csrfField(csrf)}<input type="hidden" name="status" value="${t.status === 'active' ? 'suspended' : 'active'}"><button class="alt small" type="submit">${t.status === 'active' ? 'Deactivate' : 'Activate'}</button></form>
  <a href="/admin/tenant?tenant=${esc(t._id)}">Settings</a></td></tr>`).join('')}
  </tbody></table></div>
  <div class="card"><h2>Create a tenant</h2>
  <form method="post" action="/admin/tenants">${csrfField(csrf)}
    <div class="row"><div><label for="name">Organisation name</label><input id="name" name="name" required></div>
    <div><label for="slug">Identifier</label><input id="slug" name="slug" required placeholder="north-campus"></div></div>
    <button type="submit">Create tenant</button>
  </form></div>`
});

export const adminTenantPage = ({ user, tenant, tenants = [], users = [], apps = [], events = [], csrf, notice = '', error = '', createdApp = null, issuer }) => {
  const isPlatform = user.role === 'platform_admin';
  const picker = isPlatform && tenants.length > 1 ? `<form method="get" action="/admin/tenant" style="margin-bottom:16px">
    <label for="tenant">Tenant</label><select id="tenant" name="tenant" onchange="this.form.submit()">${tenants.map(t => `<option value="${esc(t._id)}" ${String(t._id) === String(tenant?._id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></form>` : '';
  const settings = tenant?.settings || {};
  const providerField = (name, provider) => `<div class="row">
    <div><label for="${name}Enabled">${name} sign-in</label>
      <select id="${name}Enabled" name="${name}Enabled"><option value="off" ${!provider?.enabled ? 'selected' : ''}>Disabled</option><option value="on" ${provider?.enabled ? 'selected' : ''}>Enabled</option></select></div>
    <div><label for="${name}ClientId">${name} client ID</label><input id="${name}ClientId" name="${name}ClientId" value="${esc(provider?.clientId || '')}" placeholder="not configured"></div>
    <div><label for="${name}Secret">${name} client secret</label><input id="${name}Secret" name="${name}Secret" type="password" placeholder="${provider?.hasSecret ? 'stored — leave blank to keep' : 'not configured'}"></div>
  </div>`;
  return shell({
    title: 'Tenant settings',
    user,
    nav: adminNav({ user, active: 'tenant' }),
    body: `<div class="card"><h1>${esc(tenant?.name || 'Select a tenant')}</h1><p class="sub">Issuer <span class="mono">${esc(issuer)}</span> · identifier <span class="mono">${esc(tenant?.slug || '')}</span></p>
    ${noticeBlock(notice, error)}${picker}
    <form method="post" action="/admin/tenant/settings">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}">
      <div class="row">
        <div><label for="mfa">Multi-factor authentication</label><select id="mfa" name="mfa">
          ${['off', 'optional', 'required'].map(value => `<option value="${value}" ${settings.mfa === value ? 'selected' : ''}>${value === 'off' ? 'Disabled' : value === 'optional' ? 'Optional for users' : 'Required for every user'}</option>`).join('')}
        </select></div>
        <div><label for="accessTokenSeconds">Access token lifetime (seconds)</label><input id="accessTokenSeconds" name="accessTokenSeconds" type="number" min="300" max="3600" value="${esc(settings.accessTokenSeconds ?? 900)}"></div>
        <div><label for="refreshTokenSeconds">Refresh token lifetime (seconds)</label><input id="refreshTokenSeconds" name="refreshTokenSeconds" type="number" min="3600" max="2592000" value="${esc(settings.refreshTokenSeconds ?? 1209600)}"></div>
      </div>
      <div class="row">
        <div><label for="sessionLifetimeSeconds">Session lifetime (seconds)</label><input id="sessionLifetimeSeconds" name="sessionLifetimeSeconds" type="number" min="900" max="604800" value="${esc(settings.sessionLifetimeSeconds ?? 43200)}"></div>
        <div><label for="passwordMinLength">Minimum password length</label><input id="passwordMinLength" name="passwordMinLength" type="number" min="8" max="128" value="${esc(settings.passwordMinLength ?? 10)}"></div>
        <div><label for="maxFailedLogins">Lockout threshold</label><input id="maxFailedLogins" name="maxFailedLogins" type="number" min="3" max="20" value="${esc(settings.maxFailedLogins ?? 5)}"></div>
        <div><label for="lockoutMinutes">Lockout duration (minutes)</label><input id="lockoutMinutes" name="lockoutMinutes" type="number" min="1" max="1440" value="${esc(settings.lockoutMinutes ?? 15)}"></div>
      </div>
      <h2 style="margin-top:22px">Identity providers</h2>
      ${providerField('google', settings.providers?.google)}
      ${providerField('facebook', settings.providers?.facebook)}
      <button type="submit">Save settings</button>
    </form></div>

    <div class="card"><h2>Client applications</h2>
    <table><thead><tr><th>Application</th><th>Client ID</th><th>Type</th><th>Redirect URIs</th><th>Status</th><th></th></tr></thead><tbody>
    ${apps.length ? apps.map(a => `<tr><td>${esc(a.name)}</td><td class="mono">${esc(a.clientId)}</td><td>${esc(a.type)}</td><td class="mono">${a.redirectUris.map(esc).join('<br>')}</td><td><span class="pill ${a.active ? 'ok' : 'bad'}">${a.active ? 'active' : 'disabled'}</span></td>
    <td><form method="post" action="/admin/tenant/apps/${esc(a._id)}">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}"><input type="hidden" name="active" value="${a.active ? 'false' : 'true'}"><button class="alt small" type="submit">${a.active ? 'Disable' : 'Enable'}</button></form></td></tr>`).join('') : '<tr><td colspan="6" class="muted">No applications registered yet.</td></tr>'}
    </tbody></table>
    ${createdApp ? `<div class="banner ok" style="margin-top:16px">Application <strong>${esc(createdApp.name)}</strong> registered. Copy the secret now — it is stored hashed and cannot be shown again.<div class="code" style="margin-top:10px">client_id: ${esc(createdApp.clientId)}\nclient_secret: ${esc(createdApp.clientSecret)}</div></div>` : ''}
    <form method="post" action="/admin/tenant/apps">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}">
      <div class="row"><div><label for="appName">Application name</label><input id="appName" name="name" required placeholder="Library Desk"></div>
      <div><label for="appType">Client type</label><select id="appType" name="type"><option value="confidential">Confidential (server-side, keeps a secret)</option><option value="public">Public (SPA/mobile, PKCE only)</option></select></div></div>
      <label for="redirectUris">Redirect URIs (one per line, must match exactly)</label>
      <input id="redirectUris" name="redirectUris" placeholder="https://app.example.edu/callback">
      <button type="submit">Register application</button>
    </form></div>

    <div class="card"><h2>Users</h2>
    <table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>MFA</th><th>Locked</th><th></th></tr></thead><tbody>
    ${users.length ? users.map(u => `<tr><td>${esc(u.name)}<br><span class="muted mono">${esc(u.email)}</span></td><td>${esc(u.role.replace('_', ' '))}</td>
    <td><span class="pill ${u.status === 'active' ? 'ok' : 'bad'}">${esc(u.status)}</span></td><td>${u.mfa?.enabled ? 'enrolled' : '—'}</td><td>${u.lockedUntil && new Date(u.lockedUntil) > new Date() ? '<span class="pill bad">locked</span>' : '—'}</td>
    <td>
      <form method="post" action="/admin/tenant/users/${esc(u._id)}">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}">
        <input type="hidden" name="action" value="toggle-status"><input type="hidden" name="status" value="${u.status === 'active' ? 'suspended' : 'active'}">
        <button class="alt small" type="submit">${u.status === 'active' ? 'Suspend' : 'Activate'}</button></form>
      ${u.lockedUntil ? `<form method="post" action="/admin/tenant/users/${esc(u._id)}">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}"><input type="hidden" name="action" value="unlock"><button class="alt small" type="submit">Unlock</button></form>` : ''}
      ${u.mfa?.enabled ? `<form method="post" action="/admin/tenant/users/${esc(u._id)}">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}"><input type="hidden" name="action" value="reset-mfa"><button class="alt small" type="submit">Reset MFA</button></form>` : ''}
      <form method="post" action="/admin/tenant/users/${esc(u._id)}">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}"><input type="hidden" name="action" value="set-password">
        <input name="password" type="password" placeholder="New password" style="max-width:170px"><button class="alt small" type="submit">Reset password</button></form>
    </td></tr>`).join('') : '<tr><td colspan="6" class="muted">No users in this tenant yet.</td></tr>'}
    </tbody></table>
    <form method="post" action="/admin/tenant/users">${csrfField(csrf)}<input type="hidden" name="tenant" value="${esc(tenant?._id || '')}">
      <div class="row"><div><label for="userName">Full name</label><input id="userName" name="name" required></div>
      <div><label for="userEmail">Email</label><input id="userEmail" name="email" type="email" required></div>
      <div><label for="userRole">Role</label><select id="userRole" name="role"><option value="member">Member</option><option value="tenant_admin">Tenant administrator</option></select></div>
      <div><label for="userPassword">Temporary password</label><input id="userPassword" name="password" type="password" required></div></div>
      <button type="submit">Create user</button>
    </form></div>
    ${eventsTable({ events, title: 'Latest authentication events' })}`
  });
};

export const auditPage = ({ user, tenant, events = [], filter = '', csrf }) => shell({
  title: 'Audit log',
  user,
  nav: adminNav({ user, active: 'audit' }),
  body: `<div class="card"><h1>Audit log</h1><p class="sub">Authentication, token and administrative events${tenant ? ` for ${esc(tenant.name)}` : ''}. Failed sign-ins, lockouts and refresh-token replay are recorded here.</p>
  <form method="get" action="/admin/audit"><label for="type">Filter by event type</label>
    <div class="row"><input id="type" name="type" value="${esc(filter)}" placeholder="login.failure">
    <button type="submit">Filter</button></div>
  </form>
  <p class="sub" style="margin-top:14px"><a href="/admin/audit">Clear filter</a></p></div>
  ${eventsTable({ events, title: filter ? `Events matching ${filter}` : 'All events' })}`
});
