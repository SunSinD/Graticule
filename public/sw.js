const CACHE_NAME = '__GRATICULE_CACHE__';
const CACHE_PREFIX = 'graticule-';
const PRECACHE_ASSETS = [/*__GRATICULE_PRECACHE__*/];
const STATIC_ASSETS = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png'];

// Reads one cache without creating it, so a missing cache never comes back empty at the end of the list.
const matchIn = (name, request, options = {}) => caches.match(request, { ...options, cacheName: name });

const isComplete = async (name) => Boolean(await matchIn(name, './index.html', { ignoreSearch: true, ignoreVary: true }));

// A failed install deletes its cache, so a half filled cache is never left behind. A cache that was
// already complete under this name belongs to a working build and is kept.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const hadComplete = await isComplete(CACHE_NAME);
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll([...STATIC_ASSETS, ...PRECACHE_ASSETS]);
    } catch (error) {
      if (!hadComplete) await caches.delete(CACHE_NAME);
      throw error;
    }
    await self.skipWaiting();
  })());
});

const MAX_OLD_BUILDS = 6;

// Every other build, newest first. caches.keys() lists caches in the order they were created.
const oldBuilds = async () =>
  (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).reverse();

// Only builds whose cache was created before this one, newest first. A newer build that is still
// installing or waiting always created its cache after this one, so it is never in this list.
const predecessors = async () => {
  const names = await caches.keys();
  const own = names.indexOf(CACHE_NAME);
  if (own < 0) return [];
  return names.slice(0, own).filter((name) => name.startsWith(CACHE_PREFIX)).reverse();
};

// While a newer build installs or waits, this worker deletes nothing, even a build it would reuse.
const successorPending = () => Boolean(self.registration.installing || self.registration.waiting);

const deleteOldBuilds = async () => {
  for (const name of await predecessors()) {
    if (successorPending()) return;
    await caches.delete(name);
  }
};

// Tabs still open on older builds load their lazy chunks from those caches, so every complete old
// build is kept while any window is open, up to MAX_OLD_BUILDS. Incomplete caches are always deleted.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if ((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length === 0) {
      await deleteOldBuilds();
    } else {
      let kept = 0;
      for (const name of await predecessors()) {
        if (kept < MAX_OLD_BUILDS && await isComplete(name)) kept += 1;
        else if (!successorPending()) await caches.delete(name);
      }
    }
    await self.clients.claim();
  })());
});

// Install is the only place a cache is opened. Every asset is precached there, so nothing is
// written at runtime and a cache that a newer build deleted can never come back.

// True only for this build's own page: a plain 200 HTML response matching the exact index.html
// precached for this build, so comments, templates, CSS decoys or altered URLs never drop old builds.
const isCurrentPage = async (response) => {
  if (response.status !== 200) return false;
  if (!/^text\/html(?:;|$)/i.test((response.headers.get('content-type') || '').trim())) return false;
  const cached = await matchIn(CACHE_NAME, './index.html', { ignoreSearch: true, ignoreVary: true });
  if (!cached) return false;
  return (await response.text()) === (await cached.text());
};

const offline = () => new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });

// This build first, then older builds newest first, for a tab that still runs one of them.
const matchAnyBuild = async (request) => {
  for (const name of [CACHE_NAME, ...(await oldBuilds())]) {
    const hit = await matchIn(name, request, { ignoreVary: true });
    if (hit) return hit;
  }
  return undefined;
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const scopeUrl = new URL(self.registration.scope);
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== scopeUrl.origin) return;

  if (request.mode === 'navigate') {
    // A fresh page is never written into this cache: it may point at assets from a newer build,
    // and the new worker caches its own copy when it installs.
    const cachedPage = async () =>
      (await matchIn(CACHE_NAME, './index.html', { ignoreSearch: true, ignoreVary: true }))
      || (await matchIn(CACHE_NAME, './', { ignoreSearch: true, ignoreVary: true }));
    // Once the new page is the only open window, no tab can still need an older build. A new tab
    // opened next to an old one is not listed until it is ready, so this waits for it first.
    // While a newer build installs or waits, its cache is left alone, before and after the wait.
    const cleanUp = async (clientId) => {
      if (!clientId || successorPending()) return;
      for (let i = 0; i < 50 && !(await self.clients.get(clientId)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (successorPending()) return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.length > 0 && windows.every((client) => client.id === clientId)) await deleteOldBuilds();
    };
    const page = fetch(request);
    // A server can still answer with an older page, which needs its older build, so old builds are
    // only deleted when the page that loaded is this build's own. The copy is read before the page uses it.
    const ownPage = page.then((response) => isCurrentPage(response.clone()));
    event.waitUntil(ownPage.then((own) => (own ? cleanUp(event.resultingClientId) : undefined)).catch(() => undefined));
    event.respondWith(
      page
        .then(async (response) => (response.ok ? response : (await cachedPage()) || response))
        .catch(async () => (await cachedPage())
          || offline()),
    );
    return;
  }

  if (requestUrl.pathname.startsWith(scopeUrl.pathname)) {
    const relativePath = requestUrl.pathname.slice(scopeUrl.pathname.length);
    const isHashedAsset = relativePath.startsWith('assets/');
    const isStaticAsset = /^(?:manifest\.webmanifest|favicon\.svg|icon-[^/]+\.png)$/.test(relativePath);

    if (isStaticAsset || isHashedAsset) {
      event.respondWith((async () => {
        const cached = isStaticAsset ? await matchIn(CACHE_NAME, request, { ignoreVary: true }) : await matchAnyBuild(request);
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return offline();
        }
      })());
    }
  }
});
