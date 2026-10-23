// Shared OpenID Connect client used by both sample applications (Campus Portal and Library Desk).
// Zero dependencies: it redirects to the centralized provider, exchanges the code server-side, verifies the
// id_token signature against the provider JWKS and keeps its own session cookie.
const http = require('node:http');
const crypto = require('node:crypto');

const config = {
  issuer: (process.env.SSO_ISSUER || 'http://localhost:5000').replace(/\/$/, ''),
  clientId: process.env.SSO_CLIENT_ID || '',
  clientSecret: process.env.SSO_CLIENT_SECRET || '',
  appName: process.env.APP_NAME || 'Sample application',
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 9101}`).replace(/\/$/, ''),
  peer: process.env.PEER_APP_URL || '',
  peerName: process.env.PEER_APP_NAME || ''
};

const pending = new Map();
const sessions = new Map();
const secure = config.publicUrl.startsWith('https://');

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const b64 = buffer => buffer.toString('base64url');
const pkce = () => {
  const verifier = b64(crypto.randomBytes(32));
  return { verifier, challenge: b64(crypto.createHash('sha256').update(verifier).digest()) };
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(rest.join('=') || '');
  }
  return cookies;
}

const currentSession = req => {
  const id = parseCookies(req.headers.cookie).demo_session;
  return id ? sessions.get(id) || null : null;
};

/** Verifies the id_token: RS256 signature from the provider's JWKS plus issuer, audience and expiry. */
async function verifyIdToken(idToken) {
  const [header, payload, signature] = String(idToken || '').split('.');
  if (!header || !payload || !signature) return { error: 'The provider did not return an id_token.' };
  const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const jwks = await fetchJson(`${config.issuer}/jwks`);
  const jwk = jwks.data.keys?.find(key => key.kid === decodedHeader.kid);
  if (!jwk) return { error: 'No matching signing key in the provider JWKS.' };
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signatureOk = crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
  if (!signatureOk) return { error: 'The id_token signature is invalid.' };
  if (claims.iss !== config.issuer) return { error: `Unexpected issuer ${claims.iss}.` };
  if (claims.aud !== config.clientId) return { error: 'The id_token was issued for a different client.' };
  if (claims.exp * 1000 < Date.now()) return { error: 'The id_token has expired.' };
  return { payload: claims };
}

function beginLogin(res, returnTo = '/') {
  const { verifier, challenge } = pkce();
  const state = b64(crypto.randomBytes(18));
  pending.set(state, { verifier, returnTo, createdAt: Date.now() });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: `${config.publicUrl}/callback`,
    scope: 'openid profile email',
    state,
    nonce: b64(crypto.randomBytes(12)),
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  res.writeHead(302, { location: `${config.issuer}/oauth/authorize?${params.toString()}` });
  res.end();
}

async function handleCallback(req, res, url) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const failure = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (failure) return html(res, 400, page({ body: `<h1>Sign-in was refused</h1><p>${esc(failure)}</p><p><a href="/login">Try again</a></p>` }));
  const record = pending.get(state);
  if (!record || !code) return html(res, 400, page({ body: '<h1>Sign-in could not be verified</h1><p>The state parameter did not match. Start again.</p><p><a href="/login">Try again</a></p>' }));
  pending.delete(state);

  const tokenResponse = await fetchJson(`${config.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.publicUrl}/callback`,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: record.verifier
    })
  });
  if (!tokenResponse.ok || !tokenResponse.data.access_token) {
    return html(res, 502, page({ body: `<h1>Token exchange failed</h1><p>${esc(tokenResponse.data.error_description || tokenResponse.data.error || 'The provider rejected the request.')}</p>` }));
  }
  const verified = await verifyIdToken(tokenResponse.data.id_token);
  if (verified.error) return html(res, 400, page({ body: `<h1>id_token rejected</h1><p>${esc(verified.error)}</p>` }));

  const userinfo = await fetchJson(`${config.issuer}/oauth/userinfo`, { headers: { authorization: `Bearer ${tokenResponse.data.access_token}` } });
  const sessionId = b64(crypto.randomBytes(24));
  sessions.set(sessionId, {
    claims: verified.payload,
    userinfo: userinfo.data,
    scope: tokenResponse.data.scope,
    expiresIn: tokenResponse.data.expires_in,
    hasRefreshToken: !!tokenResponse.data.refresh_token,
    signedInAt: new Date().toISOString()
  });
  res.writeHead(302, {
    location: record.returnTo,
    'set-cookie': `demo_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  });
  res.end();
}

function logout(res, clientId = '') {
  return res.writeHead(302, { location: `${config.issuer}/logout?client_id=${encodeURIComponent(config.clientId)}${clientId ? `&post_logout_redirect_uri=${encodeURIComponent(clientId)}` : ''}` }).end();
}

const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const json = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };

const STYLE = `body{margin:0;font:15px/1.55 "DM Sans",system-ui,sans-serif;background:#f4f7f6;color:#12211d}
.wrap{max-width:820px;margin:0 auto;padding:32px 20px 60px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
.brand{font-weight:700;display:flex;gap:10px;align-items:center}
.mark{width:32px;height:32px;border-radius:9px;background:#0b473b;color:#fff;display:grid;place-items:center}
.card{background:#fff;border:1px solid #dfe6e3;border-radius:16px;padding:24px;box-shadow:0 1px 2px rgba(16,40,34,.04)}
.card+.card{margin-top:16px}
h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:0 0 10px}
a.btn,button{display:inline-block;margin-top:14px;background:#0b473b;color:#fff;border:0;border-radius:10px;padding:11px 16px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
a.alt{background:#fff;color:#0b473b;border:1px solid #0b473b;text-decoration:none;border-radius:10px;padding:9px 14px;font-weight:600;display:inline-block;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid #eef2f1;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5d6f69}
code,pre{font-family:ui-monospace,Menlo,monospace;font-size:13px}
pre{background:#0b1f1a;color:#d8f3e8;padding:12px;border-radius:10px;overflow-x:auto}
.muted{color:#5d6f69}.pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#eaf6f1;color:#0d5b46}`;

function page({ body, session = null }) {
  const who = session ? `${esc(session.userinfo.name || session.claims.email)} · <a href="/logout">Sign out</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.appName)}</title><style>${STYLE}</style></head><body><div class="wrap">
<header><div class="brand"><span class="mark">C</span><span>${esc(config.appName)}</span></div><div class="muted">${who}</div></header>
${body}
<p class="muted" style="margin-top:18px">Signed in through CUI_Communicate single sign-on.</p>
</div></body></html>`;
}

const signedInPanel = session => `<div class="card"><h1>Welcome, ${esc(session.userinfo.name || session.claims.email)}</h1>
<p class="muted">This application never saw your password: it received an authorization code, exchanged it for tokens and verified the id_token signature against the provider's JWKS.</p>
<table><tbody>
<tr><th>Email</th><td>${esc(session.userinfo.email)}</td></tr>
<tr><th>Subject</th><td><code>${esc(session.claims.sub)}</code></td></tr>
<tr><th>Tenant</th><td>${esc(session.claims.tenant_slug || session.claims.tenant)}</td></tr>
<tr><th>Role</th><td><span class="pill">${esc(session.claims.role)}</span></td></tr>
<tr><th>Authentication methods</th><td>${esc((session.claims.amr || []).join(', '))}</td></tr>
<tr><th>Scopes</th><td><code>${esc(session.scope)}</code></td></tr>
<tr><th>Access token lifetime</th><td>${esc(session.expiresIn)}s ${session.hasRefreshToken ? '· refresh token held' : ''}</td></tr>
<tr><th>Signed in at</th><td>${esc(session.signedInAt)}</td></tr>
</tbody></table>
<pre>${esc(JSON.stringify(session.claims, null, 2))}</pre>
</div>
<div class="card"><h2>Protected API of this application</h2><p class="muted"><code>GET /api/me</code> returns your claims and answers <code>401</code> when no session cookie is present.</p><a class="alt" href="/api/me" target="_blank" rel="noreferrer">Call /api/me</a></div>
${config.peer ? `<div class="card"><h2>Single sign-on across applications</h2><p class="muted">You are already signed in to the provider, so ${esc(config.peerName)} can authenticate you without asking for credentials again.</p><a href="${esc(config.peer)}" target="_blank" rel="noreferrer">Open ${esc(config.peerName)}</a></div>` : ''}`;

function startApp({ routes }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, config.publicUrl);
      if (url.pathname === '/login') return beginLogin(res, url.searchParams.get('return_to') || '/');
      if (url.pathname === '/callback') return handleCallback(req, res, url);
      if (url.pathname === '/logout') {
        sessions.delete(parseCookies(req.headers.cookie).demo_session);
        res.writeHead(302, { location: `${config.issuer}/logout`, 'set-cookie': 'demo_session=; Path=/; Max-Age=0' });
        return res.end();
      }
      if (url.pathname === '/health') return json(res, 200, { status: 'ok', app: config.appName });
      return routes(req, res, url);
    } catch (error) {
      console.error(`${config.appName} request failed:`, error.message);
      return html(res, 500, page({ body: '<h1>Something went wrong</h1><p>The request could not be completed.</p>' }));
    }
  });
  server.listen(Number(process.env.PORT || 9101), '0.0.0.0', () => {
    console.log(`${config.appName} listening on ${config.publicUrl} (client_id ${config.clientId})`);
  });
}

module.exports = { config, currentSession, html, json, page, signedInPanel, startApp, esc };
