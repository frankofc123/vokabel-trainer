const CACHE_NAME = 'vokabel-trainer-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
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
  // Lokale API- & Login-Anfragen an den Mac Mini NIEMALS cachen
  if (event.request.url.includes('/api/') || event.request.url.includes('/login')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse; // Sofort ausgeben (Bus-Rettung!)
      }
      return fetch(event.request).catch(() => {
        // Fallback, falls gar nichts mehr geht
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});