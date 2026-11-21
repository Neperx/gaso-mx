// Service Worker básico para soporte PWA y empaquetado móvil en Android (TWA / PWABuilder)
const CACHE_NAME = 'gaso-pwa-v1';
const PRECACHE_ASSETS = [
  '/',
  '/manifest.json',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Network-first con fallback a cache
self.addEventListener('fetch', (event) => {
  // Evitar interceptar llamadas de backend/API para no cachear datos sensibles de sesión o bóveda
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/vault') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/functions/')
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
