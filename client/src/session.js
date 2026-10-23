// Workspace session handling.
//
// The access token is short-lived (15 minutes) and lives in memory only, so nothing worth stealing is left in
// localStorage and a stolen copy is useless almost immediately. The refresh token is an httpOnly cookie set by the
// API: JavaScript can never read it, and a page load restores the session by silently rotating it.
const API = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/+$/, '');
export const API_ORIGIN = API;

let accessToken = '';
let sessionLostHandler = () => {};

export const sessionToken = () => accessToken;
export const setSessionToken = value => { accessToken = value || ''; };
/** Called when the session can no longer be renewed, so the app can return to the sign-in screen. */
export const onSessionExpired = handler => { sessionLostHandler = handler || (() => {}); };

const readJson = async response => response.json().catch(() => ({}));

// One rotation at a time: every caller that ran into a 401 shares the same in-flight refresh.
let rotation = null;
export function rotateSession() {
  if (!rotation) {
    rotation = fetch(`${API}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(async response => {
        const data = await readJson(response);
        if (!response.ok || !data.token) throw new Error(data.message || 'Your session has expired. Sign in again.');
        accessToken = data.token;
        return data;
      })
      .finally(() => { rotation = null; });
  }
  return rotation;
}

/** Any API call: attaches the current access token and retries once after a silent refresh on 401. */
export async function request(path, _token, options = {}) {
  const send = () => fetch(`${API}/api${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers || {})
    }
  });
  let response = await send();
  if (response.status === 401) {
    const renewed = await rotateSession().then(() => true).catch(() => false);
    if (renewed) response = await send();
    if (response.status === 401) sessionLostHandler();
  }
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.message || 'Something went wrong');
  return data;
}

/** Keeps the token from any sign-in flow (password, registration, campus SSO) and returns the session. */
export const adoptSession = data => {
  setSessionToken(data?.token);
  return { token: data?.token, user: data?.user };
};

/** Boot-time restore: turns the refresh cookie into a fresh access token. */
export async function restoreSession() {
  const data = await rotateSession();
  return { token: data.token, user: data.user };
}

/** Real server-side sign-out: revokes this session's refresh family, then forgets the access token. */
export async function endSession() {
  try {
    await fetch(`${API}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch { /* signing out locally is still correct when the network is gone */ }
  accessToken = '';
}
