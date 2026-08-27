// Bump CACHE_NAME on every deploy that changes any precached file.
// (Also update APP_VERSION in js/app.js so the on-screen version label matches.)
var CACHE_NAME = 'ocsr-v1.12';

var PRECACHE_URLS = [
  './',
  './index.html',
  './fixes.html',
  './css/style.css',
  './js/calc.js',
  './js/storage.js',
  './js/chart.js',
  './js/almanacCache.js',
  './js/fixStorage.js',
  './js/usno.js',
  './js/stars.js',
  './js/nav.js',
  './js/app.js',
  './js/fixes.js'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (c) {
      return c.addAll(PRECACHE_URLS);
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(function () {
      return clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(function () {
        return caches.match(e.request);
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request);
    })
  );
});
