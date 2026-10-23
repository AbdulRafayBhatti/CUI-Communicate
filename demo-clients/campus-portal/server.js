// Sample client application 1 — Campus Portal. Signs in through the SSO provider and protects its own API.
const { config, currentSession, html, json, page, signedInPanel, startApp, esc } = require('../shared/oidc.js');

const signedOut = () => page({
  body: `<div class="card"><h1>${esc(config.appName)}</h1>
  <p class="muted">Courses, results and fee statements for students of the university.</p>
  <p>Sign in with your university account. This application has no login form of its own — it redirects you to the central single sign-on page and receives an authorization code in return.</p>
  <a class="btn" href="/login">Sign in with CUI SSO</a>
  <p class="muted" style="margin-top:14px">The same session also unlocks ${esc(config.peerName || 'the other registered application')} without a second password.</p></div>`
});

startApp({
  routes: (req, res, url) => {
    const session = currentSession(req);

    if (url.pathname === '/api/me') {
      if (!session) return json(res, 401, { error: 'unauthorized', message: 'Sign in through the SSO provider first.' });
      return json(res, 200, {
        application: config.appName,
        authenticated: true,
        user: session.userinfo,
        claims: session.claims
      });
    }

    if (url.pathname === '/api/courses') {
      if (!session) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { courses: ['CS-301 Data Structures', 'CS-306 Computer Networks'], student: session.userinfo.email });
    }

    if (url.pathname !== '/' && url.pathname !== '') return html(res, 404, page({ body: '<h1>Not found</h1>' }));

    if (!session) return html(res, 200, signedOut());
    const courses = `<div class="card"><h2>Your courses this semester</h2><table><tbody>
      <tr><th>CS-301</th><td>Data Structures — Wednesday 09:00</td></tr>
      <tr><th>CS-306</th><td>Computer Networks — Thursday 11:00</td></tr>
      <tr><th>Fees</th><td><span class="pill">Paid</span></td></tr>
      </tbody></table><a class="alt" href="/api/courses" target="_blank" rel="noreferrer">Call the protected course API</a></div>`;
    return html(res, 200, page({ session, body: signedInPanel(session) + courses }));
  }
});
