/**
 * firebase.js — Firebase Auth client setup, used ONLY for Google Sign-In.
 *
 * Kukora's own backend remains the source of truth for sessions and
 * authorization. Firebase here is purely an identity provider: we run the
 * Google OAuth popup through it, then hand the resulting ID token to our
 * backend (POST /api/auth/google), which verifies it and issues Kukora's
 * own JWT access/refresh pair.
 *
 * Config comes from Vite env vars (.env, VITE_FIREBASE_*). These are
 * public client identifiers, not secrets — see Firebase docs — but they
 * still need a real project to be useful, hence the guard below.
 */
import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId
);

let auth = null;
if (isFirebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
} else if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.warn('[firebase] VITE_FIREBASE_* env vars not set — Google Sign-In button will be disabled.');
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/**
 * Runs the Google popup flow and returns a fresh Firebase ID token.
 * Throws a normalized Error with a `.code` so callers can show a specific
 * message for popup-blocked / popup-closed / network-failure cases.
 */
export async function signInWithGoogle() {
  if (!auth) {
    const err = new Error('Google Sign-In is not configured for this deployment.');
    err.code = 'not-configured';
    throw err;
  }
  const result = await signInWithPopup(auth, googleProvider);
  const idToken = await result.user.getIdToken();
  return idToken;
}

export async function firebaseLogout() {
  if (!auth) return;
  try { await firebaseSignOut(auth); } catch { /* best-effort, backend session is authoritative */ }
}

export { auth };
