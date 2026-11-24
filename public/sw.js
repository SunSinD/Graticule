const CACHE_NAME = '__GRATICULE_CACHE__';
const CACHE_PREFIX = 'graticule-';
const PRECACHE_ASSETS = [/*__GRATICULE_PRECACHE__*/];
const STATIC_ASSETS = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png'];

// Two deployments can share one origin under different paths, like /a/ and /b/. One under a path adds
// that path to its cache name, so neither ever takes the other's caches for its own older builds. The
// one at the origin root keeps the plain name.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const SCOPE_TAG = SCOPE_PATH === '/' ? '' : `@${SCOPE_PATH}`;
const OWN_CACHE = `${CACHE_NAME}${SCOPE_TAG}`;
const tagOf = (name) => (name.includes('@') ? name.slice(name.indexOf('@')) : '');

// Reads one cache without creating it, so a missing cache never comes back empty at the end of the list.
const matchIn = (name, request, options = {}) => caches.match(request, { ...options, cacheName: name });

const isComplete = async (name) => Boolean(await matchIn(name, './index.html', { ignoreSearch: true, ignoreVary: true }));

const isOwnAsset = (pathname) => {
  if (!pathname.startsWith(SCOPE_PATH)) return false;
  const rel = pathname.slice(SCOPE_PATH.length);
  return rel === ''
    || rel === 'index.html'
    || rel === 'manifest.webmanifest'
    || rel === 'favicon.svg'
    || /^icon-[^/]+\.png$/.test(rel)
    || (rel.startsWith('assets/') && !rel.slice(7).includes('/'));
};

// True for a cache exclusively owned by this deployment (safe to delete during pruning). Caches from
// before scoped names have no tag: a path deployment owns an untagged cache only if it holds this
// path's page and no entries from another scope (including nested paths), and the root deployment owns
// an untagged cache only if every entry belongs to root (empty untagged caches are failed root installs).
const isOwn = async (name) => {
  if (!name.startsWith(CACHE_PREFIX)) return false;
  const tag = tagOf(name);
  if (tag) return tag === SCOPE_TAG;
  const requests = await (await caches.open(name)).keys();
  if (SCOPE_TAG && !(await isComplete(name))) return false;
  return requests.every((request) => isOwnAsset(new URL(request.url).pathname));
};

// A failed install deletes its cache, so a half filled cache is never left behind. A cache that was
// already complete under this name belongs to a working build and is kept.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const hadComplete = await isComplete(OWN_CACHE);
    try {
      const cache = await caches.open(OWN_CACHE);
      await cache.addAll([...STATIC_ASSETS, ...PRECACHE_ASSETS]);
    } catch (error) {
      if (!hadComplete) await caches.delete(OWN_CACHE);
      throw error;
    }
    await self.skipWaiting();
  })());
});

const MAX_OLD_BUILDS = 6;

// Every other build of this deployment, newest first (including pre-2.0.7 untagged caches that hold
// this deployment's own page, so an already-open tab upgrading under a subpath still resolves its
// lazy chunks offline). caches.keys() lists caches in the order they were created.
const oldBuilds = async () => {
  const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && name !== OWN_CACHE).reverse();
  const mine = [];
  for (const name of names) {
    const tag = tagOf(name);
    if (tag === SCOPE_TAG || (!tag && await isComplete(name))) mine.push(name);
  }
  return mine;
};

// Only builds of this deployment whose cache was created before this one, newest first. A newer
// build that is still installing or waiting always created its cache after this one, so it is never
// in this list.
const predecessors = async () => {
  const names = await caches.keys();
  const own = names.indexOf(OWN_CACHE);
  if (own < 0) return [];
  const mine = [];
  for (const name of names.slice(0, own).reverse()) if (await isOwn(name)) mine.push(name);
  return mine;
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

// Install is the only place a cache is written. Every asset is precached there, so nothing is
// written at runtime and a cache that a newer build deleted can never come back.

// True only for this build's own page: a plain 200 HTML response matching the exact index.html
// precached for this build, so comments, templates, CSS decoys or altered URLs never drop old builds.
const isCurrentPage = async (response) => {
  if (response.status !== 200) return false;
  if (!/^text\/html(?:;|$)/i.test((response.headers.get('content-type') || '').trim())) return false;
  const cached = await matchIn(OWN_CACHE, './index.html', { ignoreSearch: true, ignoreVary: true });
  if (!cached) return false;
  return (await response.text()) === (await cached.text());
};

const offline = () => new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });

// This build first, then older builds newest first, for a tab that still runs one of them.
const matchAnyBuild = async (request) => {
  for (const name of [OWN_CACHE, ...(await oldBuilds())]) {
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
      (await matchIn(OWN_CACHE, './index.html', { ignoreSearch: true, ignoreVary: true }))
      || (await matchIn(OWN_CACHE, './', { ignoreSearch: true, ignoreVary: true }));
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
        const cached = isStaticAsset ? await matchIn(OWN_CACHE, request, { ignoreVary: true }) : await matchAnyBuild(request);
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
