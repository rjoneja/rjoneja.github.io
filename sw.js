// Ordo's service worker. It caches nothing: the game always loads fresh from the website.
// It's here because some browsers only offer "Install app" / "Add to home screen" to sites that have one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
