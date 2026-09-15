// Bump CACHE_NAME on every deploy that changes any precached file.
// (Also update APP_VERSION in js/app.js so the on-screen version label matches.)
importScripts('./js/version.js');

var CACHE_NAME = 'ocsr-' + APP_VERSION;

var PRECACHE_URLS = [
  './',
  './index.html',
  './fixes.html',
  './planning.html',
  './sights.html',
  './drleg.html',
  './passages.html',
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
  './js/fixes.js',
  './js/planning.js',
  './js/planningStorage.js',
  './js/sights.js',
  './js/drleg.js',
  './js/drlegStorage.js',
  './js/passageStorage.js',
  './js/passages.js',
  './js/version.js'
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
  if (e.request.method !== 'GET') return;
  // Network-first, falling back to cache -- consistently, for every
  // same-origin request, not just page navigations (as before). Serving
  // everything else cache-first meant a freshly deployed JS/CSS file could
  // keep being served stale for a real, confusing stretch of time after an
  // update, even with skipWaiting()/clients.claim() already active -- a
  // genuine source of "my fix isn't taking effect" confusion, not just a
  // theoretical risk. Falling back to cache (rather than failing outright)
  // is what keeps this working offline, which is the whole point of this
  // app -- and every successful network fetch also refreshes the cache, so
  // the offline fallback itself doesn't stay stuck at whatever was
  // precached at install time.
  e.respondWith(
    fetch(e.request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (c) { c.put(e.request, copy); });
      return response;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
