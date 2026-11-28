// Service Worker para GASO MX - PWA & Android TWA con soporte Offline robusto
const CACHE_NAME = 'gaso-pwa-v18';
const STATIC_RESOURCES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
  '/screenshot-mobile.png',
  '/screenshot-desktop.png',
  '/cursor-cotizador.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_RESOURCES).catch(err => {
        console.warn('Pre-cache error:', err);
      });
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // No interceptar peticiones no-GET ni endpoints dinámicos de backend
  if (
    req.method !== 'GET' ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/crm') ||
    url.pathname.startsWith('/gemini') ||
    url.pathname.startsWith('/portal') ||
    url.pathname.startsWith('/cuenta') ||
    url.pathname.startsWith('/vault') ||
    url.pathname.startsWith('/mercadopago') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/functions/')
  ) {
    return;
  }

  // Para navegación a páginas HTML: estrategia Network-first sin caché HTTP intermedia
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(req).then(cached => cached || caches.match('/') || caches.match('/index.html'));
        })
    );
    return;
  }

  // Para recursos estáticos (imágenes, fuentes, css, js): Cache-first con actualización en segundo plano
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
