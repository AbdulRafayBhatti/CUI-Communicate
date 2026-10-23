// Google/Facebook sign-in for the workspace login screen.
// The messaging workspace is an OpenID Connect client of the campus SSO provider: the buttons start the provider's
// social flow for the registered client `cui-communicate`, the provider returns an authorization code to /sso/callback,
// and the API (which holds the client secret) exchanges it and issues the usual workspace session.
import { useState } from 'react';

const API = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/+$/, '');
// The SSO provider is mounted at the root of the same API server (OIDC issuer = API origin).
const SSO_ISSUER = (import.meta.env.VITE_SSO_URL || API).replace(/\/+$/, '');
const CLIENT_ID = import.meta.env.VITE_SSO_CLIENT_ID || 'cui-communicate';
export const CALLBACK_PATH = '/sso/callback';
const PENDING_KEY = 'cui_sso_pending';

const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (length = 32) => base64url(crypto.getRandomValues(new Uint8Array(length)));
const challengeOf = async verifier => base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

/** Sends the browser to the provider's Google/Facebook flow, carrying this workspace's authorization request. */
export async function beginSsoSignIn(provider) {
  const state = randomString(18);
  const verifier = randomString(32);
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: `${window.location.origin}${CALLBACK_PATH}`,
    scope: 'openid profile email',
    state,
    nonce: randomString(12),
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256'
  });
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier }));
  // The provider verifies the social identity first, then returns to this authorization request and issues the code.
  const start = new URLSearchParams({ client_id: CLIENT_ID, return_to: `/oauth/authorize?${authorize.toString()}` });
  window.location.assign(`${SSO_ISSUER}/sso/oauth/${provider}/start?${start.toString()}`);
}

/** Completes /sso/callback: checks the state, exchanges the code through the API and returns the workspace session. */
export async function completeSsoSignIn() {
  try {
    const params = new URLSearchParams(window.location.search);
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    sessionStorage.removeItem(PENDING_KEY);
    if (params.get('error')) throw new Error(params.get('error_description') || 'The campus SSO provider refused the sign-in.');
    const code = params.get('code');
    if (!code) throw new Error('The sign-in response did not include an authorization code.');
    if (!pending?.verifier || params.get('state') !== pending.state) throw new Error('This sign-in response did not match the request that started it.');
    const response = await fetch(`${API}/api/auth/sso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: pending.verifier })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'The campus SSO sign-in could not be completed.');
    return data;
  } finally {
    window.history.replaceState({}, '', '/');
  }
}

const GoogleMark = () => <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
  <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>
  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"/>
  <path fill="#FBBC05" d="M5.27 14.29a7.19 7.19 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09z"/>
  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.7 0 3.99 2.47 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/>
</svg>;

const FacebookMark = () => <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
  <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.7 4.53-4.7 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.95.93-1.95 1.88v2.28h3.32l-.53 3.49h-2.79V24C19.61 23.09 24 18.1 24 12.07z"/>
</svg>;

/** Google/Facebook buttons for the sign-in screen. */
export function SsoButtons({ onError }) {
  const [pending, setPending] = useState('');
  const start = async provider => {
    setPending(provider);
    try { await beginSsoSignIn(provider); } catch (error) { setPending(''); onError?.(error.message); }
  };
  return <div className="sso-block">
    <div className="auth-divider"><span>or continue with</span></div>
    <div className="sso-buttons">
      <button type="button" className="sso-btn" onClick={() => start('google')} disabled={!!pending}>
        <GoogleMark/>{pending === 'google' ? 'Connecting…' : 'Google'}
      </button>
      <button type="button" className="sso-btn" onClick={() => start('facebook')} disabled={!!pending}>
        <FacebookMark/>{pending === 'facebook' ? 'Connecting…' : 'Facebook'}
      </button>
    </div>
    <p className="sso-note">Signs you in through the campus single sign-on provider.</p>
  </div>;
}
