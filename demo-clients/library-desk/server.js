// Sample client application 2 — Library Desk. Opening this app while the provider session is alive proves
// single sign-on: no credentials are requested a second time.
const { config, currentSession, html, json, page, signedInPanel, startApp, esc } = require('../shared/oidc.js');

const signedOut = () => page({
  body: `<div class="card"><h1>${esc(config.appName)}</h1>
  <p class="muted">Borrowed items, due dates and hold requests for the campus library.</p>
  <p>This is a second registered application: it has its own client_id and redirect URI, but shares the same identity provider.</p>
  <a class="btn" href="/login">Sign in with CUI SSO</a></div>`
});

startApp({
  routes: (req, res, url) => {
    const session = currentSession(req);

    if (url.pathname === '/api/me') {
      if (!session) return json(res, 401, { error: 'unauthorized', message: 'Sign in through the SSO provider first.' });
      return json(res, 200, { application: config.appName, authenticated: true, user: session.userinfo, claims: session.claims });
    }

    if (url.pathname === '/api/loans') {
      if (!session) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { loans: [{ title: 'Introduction to Algorithms', due: '2026-11-02' }], member: session.userinfo.email });
    }

    if (url.pathname !== '/' && url.pathname !== '') return html(res, 404, page({ body: '<h1>Not found</h1>' }));

    if (!session) return html(res, 200, signedOut());
    const loans = `<div class="card"><h2>Your library account</h2><table><tbody>
      <tr><th>Introduction to Algorithms</th><td>Due 2 November 2026</td></tr>
      <tr><th>Outstanding fines</th><td><span class="pill">None</span></td></tr>
      </tbody></table><a class="alt" href="/api/loans" target="_blank" rel="noreferrer">Call the protected loan API</a></div>`;
    return html(res, 200, page({ session, body: signedInPanel(session) + loans }));
  }
});
