// public/sw.js - OnMyWay (OMW) Service Worker
// Privacy-first PWA caching and background pause notification handler (ZERO coordinates in payload)

const CACHE_NAME = 'omw-pwa-v1';
const PRECACHE_ASSETS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/chatLOGO.png',
  '/ting.mp3',
  '/css/app.css',
  '/css/room.css',
  '/js/room.js',
  '/icons/sprite.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] Precache issue:', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Do not cache API or Socket.io traffic
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request).then((res) => res || caches.match('/offline.html')))
  );
});

// Push & Local Notification Scheduling
// Requirement: "Sharing paused. Open OnMyWay to resume." with NO coordinates in the payload.
let pendingPauseTimer = null;

self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SCHEDULE_PAUSE_NOTIFICATION') {
    if (pendingPauseTimer) clearTimeout(pendingPauseTimer);
    const delay = event.data.delayMs || 30000;
    const targetUrl = event.data.roomUrl || '/';

    pendingPauseTimer = setTimeout(() => {
      self.registration.showNotification('OnMyWay (OMW)', {
        body: 'Sharing paused. Open OnMyWay to resume.',
        icon: '/chatLOGO.png',
        badge: '/chatLOGO.png',
        tag: 'omw-sharing-paused',
        renotify: true,
        data: { url: targetUrl }
      });
      pendingPauseTimer = null;
    }, delay);
  } else if (event.data.type === 'CANCEL_PAUSE_NOTIFICATION') {
    if (pendingPauseTimer) {
      clearTimeout(pendingPauseTimer);
      pendingPauseTimer = null;
    }
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
