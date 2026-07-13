/**
 * firebase-messaging-sw.js
 *
 * Kukora uses Firebase ONLY for Google Sign-In (identity verification),
 * NOT for Firebase Cloud Messaging (FCM) push notifications.
 * This file exists purely to unregister any stale FCM service worker that
 * a browser may have cached from a previous version of the app, preventing
 * the "[firebase-messaging-sw] Config no inyectada — SW inactivo" warning.
 *
 * If FCM push notifications are added in the future, replace this file
 * with a real messaging service worker that imports and configures
 * firebase/messaging.
 */

// Self-unregister: removes this service worker registration immediately
// so it does not appear in DevTools → Application → Service Workers and
// does not produce any console noise on subsequent page loads.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', async () => {
  // Unregister this SW so the browser never loads it again.
  // After this, any FCM-related service worker entries in the browser's
  // SW registry will be gone until explicitly re-registered.
  const registration = await self.registration;
  if (registration) {
    await registration.unregister();
  }
});
