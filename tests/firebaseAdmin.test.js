import { describe, it, expect } from 'vitest';
import { verifyFirebaseIdToken } from '../server/infrastructure/firebaseAdmin.js';

// In the vitest environment FIREBASE_PROJECT_ID is intentionally unset (see
// vitest.config.js env block), so firebaseAdmin.js takes its "not configured"
// branch at module load time (app = null) and logs a warning instead of
// calling admin.initializeApp(). This lets us exercise the real,
// no-credentials-required code path without mocking the firebase-admin SDK.
describe('firebaseAdmin — verifyFirebaseIdToken (FIREBASE_PROJECT_ID unset)', () => {
  it('rejects with FIREBASE_NOT_CONFIGURED when no Firebase project is configured', async () => {
    await expect(verifyFirebaseIdToken('some-token')).rejects.toThrow('FIREBASE_NOT_CONFIGURED');
  });

  it('rejects with FIREBASE_NOT_CONFIGURED even before validating the token shape', async () => {
    // Because app is null, the FIREBASE_NOT_CONFIGURED check fires first
    // regardless of whether the token argument itself is well-formed.
    await expect(verifyFirebaseIdToken(undefined)).rejects.toThrow('FIREBASE_NOT_CONFIGURED');
    await expect(verifyFirebaseIdToken(12345)).rejects.toThrow('FIREBASE_NOT_CONFIGURED');
  });
});
