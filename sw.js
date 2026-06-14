const CACHE_NAME = 'yumi-v32';
const ASSETS = [
  './',
  './index.html',
  './index.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-192-light.png',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install Service Worker
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching all static shell assets');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Service Worker
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Interceptor
self.addEventListener('fetch', (e) => {
  // Skip cross-origin POST/PUT requests and Google APIs (which are dynamic)
  if (e.request.method !== 'GET' || e.request.url.includes('googleapis.com') || e.request.url.includes('google.com')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached asset, but fetch updated version in background for next time (Stale-While-Revalidate)
        fetch(e.request).then((networkResponse) => {
          if (networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, networkResponse));
          }
        }).catch(() => {/* Ignore network failures when offline */});
        
        return cachedResponse;
      }
      
      // Fallback to network
      return fetch(e.request).then((networkResponse) => {
        // Cache the dynamically loaded resource if it is a local asset or external font/icon
        if (networkResponse.status === 200 && (e.request.url.startsWith(self.location.origin) || e.request.url.includes('fonts.gstatic.com'))) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback for document navigation if completely offline
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
