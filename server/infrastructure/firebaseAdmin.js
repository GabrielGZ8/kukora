'use strict';
/**
 * firebaseAdmin.js — Verifies Google Sign-In ID tokens issued by Firebase Auth.
 *
 * Firebase is used ONLY as an identity provider (Google OAuth handshake).
 * It never issues Kukora's session: once a token is verified here, the
 * backend mints its own JWT access/refresh pair exactly like the password
 * login flow in auth.js. This keeps authorization logic single-sourced.
 *
 * No service-account credentials are required — verifying an ID token only
 * needs the Firebase project ID; the Admin SDK fetches Google's public
 * signing certs itself and checks the token's signature, audience (aud ===
 * projectId), issuer and expiry.
 */

const admin = require('firebase-admin');
const { logger } = require('./logger');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';

let app = null;
if (PROJECT_ID) {
  app = admin.initializeApp({ projectId: PROJECT_ID });
} else {
  logger.warn('firebaseAdmin', 'FIREBASE_PROJECT_ID not set — Google Sign-In endpoint will reject all requests');
}

/**
 * Verifies a Firebase ID token (sent by the frontend after a Google
 * popup/redirect sign-in). Returns the decoded payload (uid, email,
 * email_verified, name, picture) or throws.
 */
async function verifyFirebaseIdToken(idToken) {
  if (!app) throw new Error('FIREBASE_NOT_CONFIGURED');
  if (!idToken || typeof idToken !== 'string') throw new Error('MISSING_ID_TOKEN');
  return admin.auth(app).verifyIdToken(idToken);
}

module.exports = { verifyFirebaseIdToken };
