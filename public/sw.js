const CACHE = 'bixi-v5';
const STATIC = [
  '/',
  '/index.html',
  '/atlas.html',
  '/heatmap.html',
  '/history.html',
  '/style.css',
  '/atlas.css',
  '/heatmap.css',
  '/history.css',
  '/js/app.js',
  '/js/atlas.js',
  '/js/heatmap.js',
  '/js/history.js',
  '/js/map.js',
  '/js/geo.js',
  '/js/trips.js',
  '/js/ui.js',
  '/icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { pathname } = new URL(e.request.url);

  // HTML et API : réseau en priorité, cache en fallback offline
  // → l'utilisateur voit toujours la dernière version dès qu'il a du réseau
  if (pathname.startsWith('/api/') || pathname.endsWith('.html') || pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // JS/CSS/icônes : cache en priorité (changent peu entre visites)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});

// Notification push envoyée par le serveur (fonctionne même app fermée / écran verrouillé)
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { /* payload non-JSON, on ignore */ }

  const title = data.title || '🚲 Vélo arrivé !';
  const body  = data.body  || 'Le vélo suivi est revenu dans le flux.';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      // Un tag par vélo : plusieurs suivis simultanés ne doivent pas s'écraser.
      tag: `bixi-watch-${data.bikeId || Date.now()}`,
      data,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const appClient = clientList.find(c => {
        const path = new URL(c.url).pathname;
        return path === '/' || path.endsWith('/index.html');
      });

      if (appClient) {
        appClient.postMessage({ type: 'bike-arrived', ...data });
        return appClient.focus();
      }

      const params = new URLSearchParams();
      if (data.lat != null && data.lon != null) {
        params.set('focusLat', data.lat);
        params.set('focusLon', data.lon);
      }
      if (data.depLat != null && data.depLon != null) {
        params.set('focusDepLat', data.depLat);
        params.set('focusDepLon', data.depLon);
      }
      if (data.bikeId) params.set('focusBike', data.bikeId);

      const url = params.toString() ? `/?${params}` : '/';
      return self.clients.openWindow(url);
    })
  );
});
