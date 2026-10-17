// Lets the phone open FloatNote with no connection. Network first, the cache as
// the fallback: index.html, core.js and sync.js must stay in step, and a
// cache-first worker serves a stale set until its cache name changes. The sync
// API is never cached; offline, sync.js reads offline and keeps the edits.
const CACHE = 'floatnote-1';
const SHELL = ['./', 'index.html', 'core.js', 'sync.js', 'web-api.js', 'manifest.json', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // A shared link opens /?text=...: the page reads the query, the cache keys on the path.
  const key = url.pathname === '/' ? './' : e.request;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(key).then(hit => hit || caches.match('./')))
  );
});
