const CACHE_NAME = 'graticule-v1.1.0';
const CACHE_PREFIX = 'graticule-';
const STATIC_ASSETS = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
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
          return (await cache.match('./index.html'))
            || (await cache.match('./'))
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
      event.respondWith(
        caches.match(request).then((cached) => {
          const refresh = fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          });
          if (cached) void refresh.catch(() => undefined);
          return cached || refresh;
        }),
      );
      return;
    }

    if (isHashedAsset) {
      event.respondWith(
        caches.match(request).then((cached) => cached || fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })),
      );
    }
  }
});
