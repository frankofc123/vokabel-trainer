const CACHE_NAME = 'vokabel-trainer-v4';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/icons/monochrome.svg'
];

// Installation: Ressourcen sichern und Fehler abfangen
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll ist fehleranfällig unter iOS; wir cachen einzeln per Schleife!
      return Promise.all(
        ASSETS.map(url => {
          return cache.add(url).catch(err => {
            console.error('Fehler beim Cachen von:', url, err);
          });
        })
      );
    }).then(() => self.skipWaiting())
  );
});

// Aktivierung: Alten Cache-Müll restlos beseitigen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Strategie: Sofort lokal aus dem Cache laden (Cache-First)
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) {
    return;
  }
  if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/login') return;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        return caches.open(CACHE_NAME)
          .then((cache) => cache.put(event.request, response.clone()))
          .then(() => response);
      }
      return response;
    }).catch(async () => {
      const cachedResponse = await caches.match(event.request);
      if (cachedResponse) return cachedResponse;
      if (event.request.mode === 'navigate') return caches.match('/index.html');
      return Response.error();
    })
  );
});