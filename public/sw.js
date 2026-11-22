const CACHE_NAME = '__GRATICULE_CACHE__';
const CACHE_PREFIX = 'graticule-';
const PRECACHE_ASSETS = [/*__GRATICULE_PRECACHE__*/];
const STATIC_ASSETS = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([...STATIC_ASSETS, ...PRECACHE_ASSETS]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
    .then((names) => Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const scopeUrl = new URL(self.registration.scope);
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== scopeUrl.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('./index.html', response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('./index.html', { ignoreSearch: true, ignoreVary: true }))
            || (await cache.match('./', { ignoreSearch: true, ignoreVary: true }))
            || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }),
    );
    return;
  }

  if (requestUrl.pathname.startsWith(scopeUrl.pathname)) {
    const relativePath = requestUrl.pathname.slice(scopeUrl.pathname.length);
    const isHashedAsset = relativePath.startsWith('assets/');
    const isStaticAsset = /^(?:manifest\.webmanifest|favicon\.svg|icon-[^/]+\.png)$/.test(relativePath);

    if (isStaticAsset) {
      const refresh = fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => undefined);
      event.waitUntil(refresh);
      event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) =>
          (await cache.match(request, { ignoreVary: true }))
          || (await refresh)
          || new Response('Offline', { status: 503 }),
        ),
      );
      return;
    }

    if (isHashedAsset) {
      event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
          const cached = await cache.match(request, { ignoreVary: true });
          if (cached) return cached;
          const res = await fetch(request);
          if (res.ok) await cache.put(request, res.clone());
          return res;
        }),
      );
    }
  }
});
