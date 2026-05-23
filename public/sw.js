const CACHE = 'bixi-v3';
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
