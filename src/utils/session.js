/**
 * session.js — Browser session identity
 *
 * Generates a UUID v4 session ID on first load and persists it in
 * localStorage. The ID is sent as X-Session-ID on every API request,
 * allowing the server to scope persistence (watchlists, portfolios,
 * alerts) to the current browser session without requiring authentication.
 *
 * The session ID is not a security credential — it is simply a stable
 * identifier for a browser session. It persists across page reloads but
 * is reset if the user clears localStorage.
 */

const SESSION_KEY = 'kukora_session_id';

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getSessionId() {
  try {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = generateUUID();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private browsing, storage quota, etc.)
    // Return a transient session ID for this page load
    if (!getSessionId._transient) {
      getSessionId._transient = generateUUID();
    }
    return getSessionId._transient;
  }
}

/**
 * apiFetch — drop-in replacement for fetch() that automatically includes
 * the session header on all requests to relative API paths.
 *
 * @example
 *   import { apiFetch } from '../utils/session';
 *   const data = await apiFetch('/api/watchlist').then(r => r.json());
 */
export function apiFetch(url, options = {}) {
  const sessionId = getSessionId();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Session-ID': sessionId,
    },
  });
}

export { getSessionId };
export default getSessionId;
