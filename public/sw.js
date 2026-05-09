const CACHE = 'bixi-v1';
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

  // API : réseau en priorité, cache en fallback offline
  if (pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // Statique : cache en priorité, puis réseau (et mise en cache)
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
