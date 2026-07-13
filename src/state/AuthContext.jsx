import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { _setTokenGetter } from '../api';
import { signInWithGoogle, firebaseLogout } from '../firebase';

/**
 * AuthContext — JWT authentication state for Kukora
 *
 * Stores the access token in memory (NOT localStorage — XSS protection).
 * Refresh token lives in httpOnly cookie managed by the server.
 * Auto-refresh: 1 minute before access token expiry.
 */

const AuthContext = createContext(null);

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return null; }
}

const API_BASE = '/api/auth';

export function AuthProvider({ children }) {
  const [accessToken, setAccessToken] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // true until initial refresh attempt
  const accessTokenRef = useRef(null);
  const refreshTimerRef = useRef(null);


  // ─── Session hint flag ────────────────────────────────────────────────────
  // A tiny localStorage flag that tells us whether to attempt the silent
  // refresh on the next page load. This is NOT the session itself (the real
  // session lives in the httpOnly cookie) — it only saves an unnecessary
  // 401 round-trip on pages visited while logged out.
  function setSessionHint(value) {
    try {
      if (value) window.localStorage.setItem('kukora-has-session', '1');
      else window.localStorage.removeItem('kukora-has-session');
    } catch { /* localStorage blocked (private mode) — no-op */ }
  }

  // ─── Schedule token refresh ─────────────────────────────────────────────
  const scheduleRefresh = useCallback((token) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const payload = parseJwt(token);
    if (!payload?.exp) return;
    const expiresInMs = payload.exp * 1000 - Date.now();
    const refreshInMs = Math.max(expiresInMs - 60_000, 10_000); // 1 min before expiry
    refreshTimerRef.current = setTimeout(() => silentRefresh(), refreshInMs);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Silent refresh ─────────────────────────────────────────────────────
  // Issue 17: Distinguish definitive auth failure (401) from transient errors.
  // Only clear session state on 401 — retry after 30s for other failures.
  const silentRefresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/refresh`, { method: 'POST', credentials: 'include' });
      if (res.status === 401) {
        // Token is genuinely revoked — clear session and hint flag
        setSessionHint(false);
        setAccessToken(null);
        setUser(null);
        return;
      }
      if (!res.ok) {
        // Transient server error — retry later, keep current session alive
        refreshTimerRef.current = setTimeout(() => silentRefresh(), 30_000);
        return;
      }
      const { data } = await res.json();
      setAccessToken(data.accessToken);
      const payload = parseJwt(data.accessToken);
      setUser({ id: payload.sub, email: payload.email, name: payload.name, role: payload.role, onboardingDone: !!payload.onboardingDone });
      setSessionHint(true);
      scheduleRefresh(data.accessToken);
    } catch {
      // Network error — retry later, don't log out
      refreshTimerRef.current = setTimeout(() => silentRefresh(), 30_000);
    }
  }, [scheduleRefresh]);

  // ─── Wire API token getter ────────────────────────────────────────────────
  useEffect(() => {
    accessTokenRef.current = accessToken;
    _setTokenGetter(() => accessTokenRef.current);
  }, [accessToken]);

  // ─── On mount: attempt silent refresh from cookie ────────────────────────
  // We only attempt the silent refresh if there is a plausible chance that
  // a refresh cookie exists — detected by checking a tiny localStorage flag
  // that we set whenever a session is established. This eliminates the
  // predictable 401 on /api/auth/refresh that every anonymous page load
  // produces (and that also triggers the COOP warning loop in the console
  // because it kicks off the Firebase popup polling before auth is resolved).
  useEffect(() => {
    const mightHaveSession =
      typeof window !== 'undefined' &&
      (window.localStorage.getItem('kukora-has-session') === '1');

    if (mightHaveSession) {
      silentRefresh().finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [silentRefresh]);

  // ─── register ─────────────────────────────────────────────────────────────
  const register = useCallback(async (email, password, name) => {
    const res = await fetch(`${API_BASE}/register`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Registration failed');
    setAccessToken(json.data.accessToken);
    setUser({ ...json.data.user, onboardingDone: !!json.data.user.onboardingDone });
    setSessionHint(true);
    scheduleRefresh(json.data.accessToken);
    return json.data;
  }, [scheduleRefresh]);

  // ─── login ────────────────────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Login failed');
    setAccessToken(json.data.accessToken);
    setUser({ ...json.data.user, onboardingDone: !!json.data.user.onboardingDone });
    setSessionHint(true);
    scheduleRefresh(json.data.accessToken);
    return json.data;
  }, [scheduleRefresh]);

  // ─── loginWithGoogle ────────────────────────────────────────────────────
  // 1. Run the Firebase Google popup → get a Firebase ID token.
  // 2. Hand it to our backend, which verifies it and mints Kukora's own
  //    JWT pair (same shape as /login) — Firebase never issues our session.
  const loginWithGoogle = useCallback(async () => {
    const idToken = await signInWithGoogle(); // throws with .code on popup-blocked/closed/etc.
    const res = await fetch(`${API_BASE}/google`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(json.error || 'Google sign-in failed');
      err.code = json.code;
      throw err;
    }
    setAccessToken(json.data.accessToken);
    setUser({ ...json.data.user, onboardingDone: !!json.data.user.onboardingDone });
    setSessionHint(true);
    scheduleRefresh(json.data.accessToken);
    return json.data;
  }, [scheduleRefresh]);

  // ─── logout ───────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
    } catch { /* always clear client state */ }
    firebaseLogout(); // best-effort; doesn't block on network
    setSessionHint(false);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    setAccessToken(null);
    setUser(null);
  }, [accessToken]);

  // ─── authFetch — authenticated API requests ───────────────────────────────
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = {
      ...options.headers,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };
    return fetch(url, { ...options, headers, credentials: 'include' });
  }, [accessToken]);

  // ─── updateUser — lets SettingsPage push name changes into context ────────
  const updateUser = useCallback((fields) => {
    setUser(prev => prev ? { ...prev, ...fields } : prev);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      accessToken,
      loading,
      isAuthenticated: !!user,
      login,
      logout,
      register,
      loginWithGoogle,
      authFetch,
      updateUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
