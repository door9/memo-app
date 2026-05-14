const CACHE_NAME = 'memo-v83';
const ASSETS = [
  '/memo-app/',
  '/memo-app/index.html',
  '/memo-app/style.css',
  '/memo-app/app.js',
  '/memo-app/manifest.json',
  '/memo-app/favicon.svg',
  '/memo-app/icon-192.png',
  '/memo-app/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('api.dropboxapi.com') || e.request.url.includes('content.dropboxapi.com')) {
    return;
  }
  // Network first, fallback to cache
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
