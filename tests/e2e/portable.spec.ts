import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { test, expect } from '@playwright/test';

const root = path.resolve('.');
const pkg = JSON.parse(fs.readFileSync(path.resolve(root, 'package.json'), 'utf8')) as { version: string };
const versionPattern = pkg.version.replace(/\./g, '\\.');
const portable = path.resolve(root, 'dist-portable/graticule-portable.html');
const sample = path.resolve(root, 'tests/fixtures/samples/sine_schmitt.png');
const sweep = Array.from({ length: 10 }, (_, i) => path.resolve(root, 'tests/fixtures/samples', `sweep_${String(i + 1).padStart(2, '0')}.png`));
const cspViolations = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() => [...((globalThis as { __graticuleCspViolations?: string[] }).__graticuleCspViolations ?? [])]);

async function trackCspViolations(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (globalThis as { __graticuleCspViolations?: string[] }).__graticuleCspViolations = violations;
    window.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
  });
}

test('portable file loads and extracts without page or console errors', async ({ browser }) => {
  test.skip(!fs.existsSync(portable), `Skipping portable E2E: ${portable} is not built.`);
  const context = await browser.newContext();
  await context.setOffline(true);
  const page = await context.newPage();
  await page.addInitScript(() => {
    indexedDB.open = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await trackCspViolations(page);

  await page.goto(pathToFileURL(portable).href);
  await expect(page.getByText('History is kept for this session only.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Source code on GitHub' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Offline copy' })).toHaveCount(0);
  await page.locator('[data-testid="file-input"]').setInputFiles([sample]);
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  const csvPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const csv = await csvPending;
  expect(await fs.promises.readFile((await csv.path())!, 'utf8')).toContain(`# Graticule v${pkg.version}`);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  await context.close();
});

test('first visit becomes available offline and extracts after reload', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await expect(page.locator('[data-testid="file-input"]')).toBeAttached();
  await expect(page.getByRole('link', { name: 'Offline copy' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('[data-testid="file-input"]').setInputFiles([sample]);
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await context.close();
});

test('Try a sample works in the portable file over file:// with no CSP or console errors', async ({ browser }) => {
  test.skip(!fs.existsSync(portable), `Skipping portable E2E: ${portable} is not built.`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await trackCspViolations(page);

  await page.goto(pathToFileURL(portable).href);
  await page.getByRole('main').getByRole('button', { name: 'Try a sample', exact: true }).click();
  await expect(page.locator('.file-row', { hasText: 'sine_schmitt.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="measurement-summary"]')).toContainText(/15\.\d+\s*V/);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  await context.close();
});

test('Try a sample works offline after the first visit', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await expect(page.locator('[data-testid="file-input"]')).toBeAttached();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('main').getByRole('button', { name: 'Try a sample', exact: true }).click();
  await expect(page.locator('.file-row', { hasText: 'sine_schmitt.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await context.close();
});

test('portable HTML over HTTP loads and extracts with no 404 or CSP errors', async ({ browser }) => {
  test.skip(!fs.existsSync(portable), `Skipping portable E2E: ${portable} is not built.`);
  const html = await fs.promises.readFile(portable);
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/graticule-portable.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start portable HTTP server.');

  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const badResponses: number[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(response.status());
  });
  await trackCspViolations(page);

  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator('[data-testid="file-input"]').setInputFiles([sample]);
    await page.getByRole('button', { name: 'Extract', exact: true }).click();
    await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
    expect(badResponses).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('portable file extracts a ten-capture Bode batch without errors', async ({ browser }) => {
  test.skip(!fs.existsSync(portable), `Skipping portable E2E: ${portable} is not built.`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await trackCspViolations(page);

  await page.goto(pathToFileURL(portable).href);
  await page.locator('[data-testid="file-input"]').setInputFiles(sweep);
  await page.getByRole('button', { name: 'Extract Bode (10)' }).click();
  await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[aria-label="Phase plot"]')).toBeVisible();
  await expect(page.getByText(/-3 dB/i)).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  await context.close();
});

test('portable file runs the math, XY and FFT views and the zip report from inlined code', async ({ browser }) => {
  test.skip(!fs.existsSync(portable), `Skipping portable E2E: ${portable} is not built.`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await trackCspViolations(page);

  await page.goto(pathToFileURL(portable).href);
  await page.locator('[data-testid="file-input"]').setInputFiles([sample]);
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Add math channel' }).click();
  await expect(page.locator('[data-testid="measurement-summary"] thead')).toContainText('C1 - C2');
  await page.keyboard.press('4');
  await expect(page.locator('[data-testid="xy-plot"] svg')).toBeVisible();
  await page.keyboard.press('5');
  await expect(page.locator('[data-testid="fft-plot"] svg')).toBeVisible();
  await expect(page.locator('[data-testid="fft-summary"]')).toContainText('Fundamental');

  await page.locator('[data-testid="file-input"]').setInputFiles(sweep.slice(0, 2));
  const pending = page.waitForEvent('download', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Export all (.zip)' }).click();
  expect((await pending).suggestedFilename()).toBe('graticule-report.zip');
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  await context.close();
});

async function controlledPage(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('[data-testid="file-input"]')).toBeAttached();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  return { context, page };
}

test('a tab still on the previous build loads its lazy chunks from the previous cache', async ({ browser }) => {
  const { context, page } = await controlledPage(browser);
  try {
    const result = await page.evaluate(async () => {
      const url = new URL('./assets/previous-build-chunk.js', location.href).href;
      const previous = await caches.open('graticule-v0.0.0-previous');
      await previous.put(url, new Response('export const previous = true;', { headers: { 'Content-Type': 'text/javascript' } }));
      const response = await fetch(url);
      return { status: response.status, body: await response.text() };
    });
    expect(result).toEqual({ status: 200, body: 'export const previous = true;' });
  } finally {
    await page.evaluate(() => caches.delete('graticule-v0.0.0-previous'));
    await context.close();
  }
});

test('a good asset response that cannot be cached still reaches the page', async ({ browser }) => {
  const { context, page } = await controlledPage(browser);
  try {
    await context.route('**/assets/vary-star.js', (route) =>
      route.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript', Vary: '*' }, body: 'export const ok = true;' }));
    await context.route('**/icon-vary.png', (route) =>
      route.fulfill({ status: 200, headers: { 'Content-Type': 'image/png', Vary: '*' }, body: 'png' }));
    const result = await page.evaluate(async () => {
      const asset = await fetch('./assets/vary-star.js');
      const icon = await fetch('./icon-vary.png');
      return { asset: asset.status, body: await asset.text(), icon: icon.status };
    });
    expect(result).toEqual({ asset: 200, body: 'export const ok = true;', icon: 200 });
  } finally {
    await context.close();
  }
});

test('preview serves the manifest and fully precached service worker source', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect(JSON.parse(await manifest.text()).name).toBeTruthy();

  const serviceWorker = await request.get('/sw.js');
  expect(serviceWorker.ok()).toBe(true);
  const source = await serviceWorker.text();
  expect(source).toMatch(new RegExp(`CACHE_NAME = 'graticule-v${versionPattern}-[a-f0-9]{8}'`));
  expect(source).toMatch(/"\.\/assets\/[^"]+"/);
  expect(source).toMatch(/\.\/assets\/extract\.worker-[^"]+\.js/);
  expect(source).toMatch(/\.\/assets\/pipeline-[^"]+\.js/);
  expect(source).toMatch(/\.\/assets\/sample-[^"]+\.js/);
});

const builtWorker = (): { source: string; cacheName: string } => {
  const source = fs.readFileSync(path.resolve(root, 'dist/sw.js'), 'utf8');
  return { source, cacheName: /CACHE_NAME = '([^']+)'/.exec(source)![1]! };
};

function workerFor(cacheName: string, extraPrecache: readonly string[] = []): string {
  const built = builtWorker();
  let source = built.source.replace(`CACHE_NAME = '${built.cacheName}'`, `CACHE_NAME = '${cacheName}'`);
  if (extraPrecache.length) {
    source = source.replace('const PRECACHE_ASSETS = [', `const PRECACHE_ASSETS = [${extraPrecache.map((a) => JSON.stringify(a)).join(',')},`);
  }
  return source;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves dist with a worker script the test can swap, since browser routes never see the
 * worker script fetch. Each server is its own origin, so its caches and storage start empty.
 * The same build is also served under /b/, like a second deployment on the same origin.
 */
async function releaseServer() {
  const dist = path.resolve(root, 'dist');
  let worker = builtWorker().source;
  const virtual = new Map<string, { body: string; type: string; status: number; cacheControl: string }>();
  const holds = new Map<string, { gate: Promise<void>; seen: () => void; open: () => void }>();
  const server = http.createServer(async (request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const pathname = requested.startsWith('/b/') ? requested.slice(2) : requested;
    const held = holds.get(pathname);
    if (held) {
      held.seen();
      await held.gate;
    }
    const served = virtual.get(pathname);
    if (served !== undefined) {
      response.writeHead(served.status, { 'Content-Type': served.type, 'Cache-Control': served.cacheControl });
      response.end(served.body);
      return;
    }
    if (pathname === '/sw.js' || pathname === '/blank.html') {
      const blank = pathname === '/blank.html';
      response.writeHead(200, { 'Content-Type': blank ? MIME['.html'] : MIME['.js'], 'Cache-Control': 'no-store' });
      response.end(blank ? '<!doctype html><title>blank</title>' : worker);
      return;
    }
    const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start release HTTP server.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/`,
    setWorker: (source: string) => {
      worker = source;
    },
    /** Serves a small file at this path instead of the one in dist, a script unless `type` says otherwise. */
    serve: (pathname: string, source: string, type = 'text/javascript', status = 200, cacheControl = 'no-store') => {
      virtual.set(pathname, { body: source, type, status, cacheControl });
    },
    /** Holds every request for this path until `release` is called. `requested` resolves on the first one. */
    hold: (pathname: string) => {
      let seen!: () => void;
      let open!: () => void;
      const requested = new Promise<void>((resolve) => {
        seen = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      holds.set(pathname, { gate, seen, open });
      return {
        requested,
        release: () => {
          holds.delete(pathname);
          open();
        },
      };
    },
    /** Lets every held request through, so the server can close. */
    releaseAll: () => {
      for (const [pathname, held] of [...holds]) {
        holds.delete(pathname);
        held.open();
      }
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

type Release = Awaited<ReturnType<typeof releaseServer>>;

async function withRelease(
  browser: import('@playwright/test').Browser,
  run: (release: Release, context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page) => Promise<void>,
): Promise<void> {
  const release = await releaseServer();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(release.url);
    await expect(page.locator('[data-testid="file-input"]')).toBeAttached();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await run(release, context, page);
  } finally {
    release.releaseAll();
    await context.close();
    await release.close();
  }
}

/** Serves a new worker script and waits until it activates or fails to install. */
async function updateWorker(release: Release, page: import('@playwright/test').Page, source: string): Promise<string> {
  release.setWorker(source);
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return 'no registration';
    await registration.update();
    const worker = registration.installing ?? registration.waiting;
    if (!worker) return 'no update';
    if (worker.state === 'activated' || worker.state === 'redundant') return worker.state;
    return new Promise<string>((resolve) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || worker.state === 'redundant') resolve(worker.state);
      });
    });
  });
}

/** A complete cache for an older build, holding its page and one lazy chunk only it has. */
async function seedBuild(page: import('@playwright/test').Page, cacheName: string, chunk: string, body: string): Promise<void> {
  await page.evaluate(async ({ cacheName, chunk, body }) => {
    const cache = await caches.open(cacheName);
    await cache.put(new URL('./index.html', location.href).href, new Response('<!doctype html><title>old</title>', { headers: { 'Content-Type': 'text/html' } }));
    await cache.put(new URL(`./assets/${chunk}`, location.href).href, new Response(body, { headers: { 'Content-Type': 'text/javascript' } }));
  }, { cacheName, chunk, body });
}

const fetchChunk = (page: import('@playwright/test').Page, chunk: string) =>
  page.evaluate(async (chunk) => {
    const response = await fetch(`./assets/${chunk}`);
    return { status: response.status, body: await response.text() };
  }, chunk);

const cacheNames = (page: import('@playwright/test').Page) => page.evaluate(() => caches.keys());
const BUILD_A = 'export const build = "A";';

test('a failed update leaves no cache, and the next update drops broken caches but keeps a working older build', async ({ browser }) => {
  await withRelease(browser, async (release, _context, page) => {
    const current = builtWorker().cacheName;
    await seedBuild(page, 'graticule-vA-test', 'build-a-chunk.js', BUILD_A);
    await page.evaluate(() => caches.open('graticule-vX-broken'));

    expect(await updateWorker(release, page, workerFor('graticule-vF-fail', ['./assets/missing-for-test.js']))).toBe('redundant');
    expect(await cacheNames(page)).not.toContain('graticule-vF-fail');

    expect(await updateWorker(release, page, workerFor('graticule-vC-test'))).toBe('activated');
    const names = await cacheNames(page);
    expect(names).not.toContain('graticule-vX-broken');
    expect(names).toEqual(expect.arrayContaining(['graticule-vA-test', current, 'graticule-vC-test']));
    expect(await fetchChunk(page, 'build-a-chunk.js')).toEqual({ status: 200, body: BUILD_A });
  });
});

test('a tab on an older build still gets its lazy chunks after several newer builds activate', async ({ browser }) => {
  await withRelease(browser, async (release, _context, page) => {
    await seedBuild(page, 'graticule-vA-test', 'build-a-chunk.js', BUILD_A);
    for (const name of ['graticule-vC1-test', 'graticule-vC2-test', 'graticule-vC3-test']) {
      expect(await updateWorker(release, page, workerFor(name))).toBe('activated');
    }
    expect(await cacheNames(page)).toContain('graticule-vA-test');
    expect(await fetchChunk(page, 'build-a-chunk.js')).toEqual({ status: 200, body: BUILD_A });
  });
});

test('older builds stay while another tab is open and go once the only tab reloads', async ({ browser }) => {
  await withRelease(browser, async (release, context, page) => {
    // Older builds always made their cache before the running one, so build C activates after seeding A.
    const current = 'graticule-vC-test';
    await seedBuild(page, 'graticule-vA-test', 'build-a-chunk.js', BUILD_A);
    expect(await updateWorker(release, page, workerFor(current))).toBe('activated');
    const second = await context.newPage();
    await second.goto(release.url);
    await expect(second.locator('[data-testid="file-input"]')).toBeAttached();
    await second.waitForTimeout(1_000);
    expect(await cacheNames(second)).toContain('graticule-vA-test');
    expect(await fetchChunk(page, 'build-a-chunk.js')).toEqual({ status: 200, body: BUILD_A });

    await page.close();
    await second.reload();
    await expect.poll(() => cacheNames(second), { timeout: 10_000 }).not.toContain('graticule-vA-test');
    expect(await cacheNames(second)).toContain(current);
  });
});

test('a deployment under another path on the same origin never loses its caches when this one activates', async ({ browser }) => {
  await withRelease(browser, async (release, context, page) => {
    const current = builtWorker().cacheName;
    const other = `${current}@/b/`;
    await seedBuild(page, 'graticule-vA-test', 'build-a-chunk.js', BUILD_A);

    const second = await context.newPage();
    await second.goto(`${release.url}b/`);
    await expect(second.locator('[data-testid="file-input"]')).toBeAttached();
    await second.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await second.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // A cache from before scoped names that holds the /b/ page belongs to /b/ too.
    await seedBuild(second, 'graticule-vL-legacy', 'legacy-b-chunk.js', 'export const legacy = true;');
    expect(await cacheNames(second)).toEqual(expect.arrayContaining([current, 'graticule-vA-test', other, 'graticule-vL-legacy']));

    expect(await updateWorker(release, page, workerFor('graticule-vC-test'))).toBe('activated');
    expect(await cacheNames(page)).toEqual(expect.arrayContaining(['graticule-vA-test', current, other, 'graticule-vL-legacy', 'graticule-vC-test']));

    await second.close();
    await page.reload();
    await expect.poll(() => cacheNames(page), { timeout: 10_000 }).not.toContain('graticule-vA-test');
    const names = await cacheNames(page);
    expect(names).not.toContain(current);
    expect(names).toEqual(expect.arrayContaining(['graticule-vC-test', other, 'graticule-vL-legacy']));
  });
});

test('a sole tab that gets an older page from the server keeps the older build for offline chunks', async ({ browser }) => {
  await withRelease(browser, async (release, context, page) => {
    const current = 'graticule-vC-test';
    await seedBuild(page, 'graticule-vA-test', 'build-a-chunk.js', BUILD_A);
    expect(await updateWorker(release, page, workerFor(current))).toBe('activated');
    release.serve('/', '<!doctype html><title>old build</title>', 'text/html; charset=utf-8');
    await page.reload();
    await expect(page).toHaveTitle('old build');
    await page.waitForTimeout(1_500);
    expect(await cacheNames(page)).toEqual(expect.arrayContaining(['graticule-vA-test', current]));

    await context.setOffline(true);
    expect(await fetchChunk(page, 'build-a-chunk.js')).toEqual({ status: 200, body: BUILD_A });
  });
});

test('only a plain 200 HTML page whose module script loads this build lets the sole tab drop older builds', async ({ browser }) => {
  await withRelease(browser, async (release, _context, page) => {
    const current = 'graticule-vC-test';
    await seedBuild(page, 'graticule-vA-test', 'build-a-chunk.js', BUILD_A);
    expect(await updateWorker(release, page, workerFor(current))).toBe('activated');
    const entry = /"\.\/(assets\/index-[^"/]+\.js)"/.exec(builtWorker().source)![1]!;
    const real = `<script type="module" crossorigin src="./${entry}"></script>`;
    const html = 'text/html; charset=utf-8';
    const notOurs = [
      { body: `<!doctype html><title>old build</title><!-- ${real} --><script type="module" src="./assets/index-old.js"></script>`, type: html, status: 200 },
      { body: `<!doctype html><title>old build</title><p>${entry}</p>`, type: html, status: 200 },
      { body: `<!doctype html><title>old build</title>${real}`, type: html, status: 203 },
      { body: `<!doctype html><title>old build</title>${real}`, type: 'text/plain', status: 200 },
      {
        body: `<!doctype html><title>old build</title><template><template></template>${real}</template><script type="module" src="./assets/index-old.js"></script>`,
        type: html,
        status: 200,
      },
      { body: `<!doctype html><title>old build</title><noscript>${real}</noscript><script type="module" src="./assets/index-old.js"></script>`, type: html, status: 200 },
      { body: `<!doctype html><title>old build</title><style>/* ${real} <style> */</style><script type="module" src="./assets/index-old.js"></script>`, type: html, status: 200 },
      { body: `<!doctype html><title>old build</title><script type="module" src="./${entry}?build=old"></script>`, type: html, status: 200 },
      { body: `<!doctype html><title>old build</title><script type="module" src="./other/${entry}"></script>`, type: html, status: 200 },
      { body: `<!doctype html><title>old build</title><script type="module" src="https://example.invalid/${entry}"></script>`, type: html, status: 200 },
    ];
    for (const served of notOurs) {
      release.serve('/', served.body, served.type, served.status);
      await page.reload();
      await page.waitForTimeout(1_500);
      expect(await cacheNames(page), `${served.status} ${served.type}`).toEqual(expect.arrayContaining(['graticule-vA-test', current]));
    }

    release.serve('/', fs.readFileSync(path.resolve(root, 'dist/index.html'), 'utf8'), html);
    await page.reload();
    await expect.poll(() => cacheNames(page), { timeout: 10_000 }).not.toContain('graticule-vA-test');
    expect(await cacheNames(page)).toContain(current);
  });
});

test('assets fetched at runtime are never written into a cache', async ({ browser }) => {
  const { context, page } = await controlledPage(browser);
  try {
    await context.route('**/assets/runtime-only.js', (route) =>
      route.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript' }, body: 'export const runtime = true;' }));
    await context.route('**/icon-runtime.png', (route) =>
      route.fulfill({ status: 200, headers: { 'Content-Type': 'image/png' }, body: 'png' }));
    const result = await page.evaluate(async () => {
      const asset = await fetch('./assets/runtime-only.js');
      const icon = await fetch('./icon-runtime.png');
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        asset: asset.status,
        icon: icon.status,
        cachedAsset: Boolean(await caches.match('./assets/runtime-only.js')),
        cachedIcon: Boolean(await caches.match('./icon-runtime.png')),
      };
    });
    expect(result).toEqual({ asset: 200, icon: 200, cachedAsset: false, cachedIcon: false });
  } finally {
    await context.close();
  }
});

const hasCompletePage = (page: import('@playwright/test').Page, cacheName: string) =>
  page.evaluate(async (cacheName) => Boolean(await caches.match('./index.html', { cacheName, ignoreSearch: true })), cacheName);

/** Waits until the newest worker activates or fails, without starting an update. */
const settleWorker = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.installing ?? registration?.waiting;
    if (!worker) return registration?.active ? 'activated' : 'no worker';
    if (worker.state === 'activated' || worker.state === 'redundant') return worker.state;
    return new Promise<string>((resolve) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || worker.state === 'redundant') resolve(worker.state);
      });
    });
  });

test('reloading the only tab while a newer build precaches never deletes that build cache', async ({ browser }) => {
  await withRelease(browser, async (release, _context, page) => {
    const current = builtWorker().cacheName;
    release.serve('/assets/held-for-test.js', 'export const held = true;');
    const held = release.hold('/assets/held-for-test.js');
    release.setWorker(workerFor('graticule-vB-test', ['./assets/held-for-test.js']));
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });
    await held.requested;
    expect(await cacheNames(page)).toContain('graticule-vB-test');

    await page.reload();
    await expect(page.locator('[data-testid="file-input"]')).toBeAttached();
    await page.waitForTimeout(1_500);
    expect(await cacheNames(page)).toEqual(expect.arrayContaining([current, 'graticule-vB-test']));

    held.release();
    expect(await settleWorker(page)).toBe('activated');
    expect(await cacheNames(page)).toContain('graticule-vB-test');
    expect(await hasCompletePage(page, 'graticule-vB-test')).toBe(true);
  });
});

test('a newer build precaches the new page even when the HTTP cache still holds the old one', async ({ browser }) => {
  await withRelease(browser, async (release, _context, page) => {
    const html = 'text/html; charset=utf-8';
    const oldPage = '<!doctype html><title>old page</title>';
    const newPage = '<!doctype html><title>new page</title>';
    release.serve('/index.html', oldPage, html, 200, 'public, max-age=600');
    expect(await page.evaluate(async () => (await fetch('./index.html')).text())).toBe(oldPage);
    release.serve('/index.html', newPage, html, 200, 'public, max-age=600');
    expect(await page.evaluate(async () => (await fetch('./index.html')).text())).toBe(oldPage);

    expect(await updateWorker(release, page, workerFor('graticule-vN-test'))).toBe('activated');
    const cached = await page.evaluate(async () => {
      const hit = await caches.match('./index.html', { cacheName: 'graticule-vN-test' });
      return hit ? hit.text() : null;
    });
    expect(cached).toBe(newPage);
  });
});

test('a failed install under the active cache name keeps the working cache', async ({ browser }) => {
  await withRelease(browser, async (release, context, page) => {
    const current = builtWorker().cacheName;
    expect(await hasCompletePage(page, current)).toBe(true);
    expect(await updateWorker(release, page, workerFor(current, ['./assets/missing-for-test.js']))).toBe('redundant');
    expect(await cacheNames(page)).toContain(current);
    expect(await hasCompletePage(page, current)).toBe(true);

    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="file-input"]')).toBeAttached();
  });
});

test('history frees old captures in their own transaction under a real 1 MiB Chromium quota', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Quota override needs the Chromium DevTools protocol.');
  const bundle = await esbuild.build({
    entryPoints: [path.resolve(root, 'src/ui/history.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__graticuleHistory',
    target: 'es2022',
    write: false,
  });
  const release = await releaseServer();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: release.origin, quotaSize: 1024 * 1024 });
    await page.goto(`${release.url}blank.html`);
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(async () => {
      const history = (globalThis as unknown as { __graticuleHistory: typeof import('../../src/ui/history') }).__graticuleHistory;
      const store = await history.openHistory();
      const noise = (size: number): Uint8Array => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
        return bytes;
      };
      const item = (id: string, size: number, lastUsed: number) => ({
        id, name: `${id}.png`, bytes: noise(size), url: '', addedAt: lastUsed, lastUsed,
        state: 'staged' as const, result: null, error: null, overrides: {}, profile: 'auto' as const, quality: null,
      });
      const ids = async () => (await store.loadAll()).map((i) => i.id).sort();
      const seeded = [];
      for (let i = 1; i <= 4; i += 1) seeded.push(await store.put(item(`r${i}`, 184 * 1024, i)));
      const fit = await store.put(item('new', 225 * 1024, 10));
      const afterFit = await ids();
      return { persistent: store.persistent, seeded, fit, afterFit };
    });
    expect(result.persistent).toBe(true);
    expect(result.seeded).toEqual(Array(4).fill({ ok: true, evicted: [] }));
    expect(result.fit.ok).toBe(true);
    expect(result.fit.evicted[0]).toBe('r1');
    expect(result.afterFit).toContain('new');
    for (const id of result.fit.evicted) expect(result.afterFit).not.toContain(id);

    // Release the tight 1 MiB CDP cap before verifying full rollback against real IndexedDB so
    // LevelDB's delete tombstones from the 777 KiB fill don't compete with restoring all 4 items.
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: release.origin });
    const rollback = await page.evaluate(async () => {
      const history = (globalThis as unknown as { __graticuleHistory: typeof import('../../src/ui/history') }).__graticuleHistory;
      const store = await history.openHistory();
      const origPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: { id?: string }, key?: IDBValidKey) {
        if (value && value.id === 'huge') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return origPut.call(this, value, key);
      };
      const bytes = new Uint8Array(64 * 1024);
      crypto.getRandomValues(bytes);
      const huge = await store.put({
        id: 'huge', name: 'huge.png', bytes, url: '', addedAt: 20, lastUsed: 20,
        state: 'staged' as const, result: null, error: null, overrides: {}, profile: 'auto' as const, quality: null,
      });
      const afterHuge = (await store.loadAll()).map((i) => i.id).sort();
      return { huge, afterHuge };
    });
    expect(rollback.huge).toEqual({ ok: false, evicted: [] });
    expect(rollback.afterHuge).toEqual(result.afterFit);
  } finally {
    await context.close();
    await release.close();
  }
});

test('two tabs under a quota rollback never lose a newer title to the other tab', async ({ browser }) => {
  const bundle = await esbuild.build({
    entryPoints: [path.resolve(root, 'src/ui/history.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__graticuleHistory',
    target: 'es2022',
    write: false,
  });
  const helpers = `
    window.__item = (id, size, lastUsed, title) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
      return {
        id, name: id + '.png', bytes, url: '', addedAt: lastUsed, lastUsed,
        state: 'staged', result: null, error: null, overrides: {}, profile: 'auto', quality: null,
        ...(title ? { title } : {}),
      };
    };
    window.__store = window.__graticuleHistory.openHistory();
  `;
  type Win = typeof globalThis & {
    __store: Promise<import('../../src/ui/history').HistoryStore>;
    __item: (id: string, size: number, lastUsed: number, title?: string) => import('../../src/ui/history').HistoryItem;
    __huge?: Promise<unknown>;
  };
  const release = await releaseServer();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    for (const page of [first, second]) {
      await page.goto(`${release.url}blank.html`);
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      await page.addScriptTag({ content: helpers });
    }

    await first.evaluate(async () => {
      const w = globalThis as Win & { __r1Deleted?: Promise<void>; __resume?: () => void };
      const store = await w.__store;
      for (let i = 1; i <= 4; i += 1) await store.put(w.__item(`r${i}`, 32 * 1024, i));
      let signalDeleted!: () => void;
      w.__r1Deleted = new Promise<void>((resolve) => { signalDeleted = resolve; });
      const resumeGate = new Promise<void>((resolve) => { w.__resume = resolve; });
      // Pause first right after r1's delete commits so second always races mid-eviction.
      const origTx = IDBDatabase.prototype.transaction;
      let paused = false;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
        const tx = origTx.apply(this, args);
        const os = tx.objectStore.bind(tx);
        let deletingR1 = false;
        tx.objectStore = ((name: string) => {
          const s = os(name);
          const del = s.delete.bind(s);
          s.delete = ((key: IDBValidKey | IDBKeyRange) => {
            if (!paused && key === 'r1') { paused = true; deletingR1 = true; }
            return del(key);
          }) as typeof s.delete;
          return s;
        }) as typeof tx.objectStore;
        const desc = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
        Object.defineProperty(tx, 'oncomplete', {
          // The delete may run after the handler is set, once a read in the same transaction returns.
          set(fn: ((this: IDBTransaction, ev: Event) => unknown) | null) {
            if (!fn) { desc.set!.call(this, fn); return; }
            desc.set!.call(this, function (this: IDBTransaction, ev: Event) {
              if (!deletingR1) return fn.call(this, ev);
              signalDeleted();
              void resumeGate.then(() => fn.call(this, ev));
            });
          },
          get() { return desc.get!.call(this); },
        });
        return tx;
      } as typeof IDBDatabase.prototype.transaction;
      const origPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: { id?: string }, key?: IDBValidKey) {
        if (value && value.id === 'huge') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return origPut.call(this, value, key);
      };
      w.__huge = store.put(w.__item('huge', 64 * 1024, 20));
      await w.__r1Deleted;
    });

    const renamePromise = second.evaluate(async () => {
      const w = globalThis as Win;
      const store = await w.__store;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('graticule-history', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const r1Missing = await new Promise<boolean>((resolve, reject) => {
        const req = db.transaction('items', 'readonly').objectStore('items').getKey('r1');
        req.onsuccess = () => resolve(req.result === undefined);
        req.onerror = () => reject(req.error);
      });
      db.close();
      const renamed = await store.put(w.__item('r2', 32 * 1024, 2, 'Newer title'));
      return { evicting: r1Missing, renamed };
    });

    // Give second a moment to enqueue on the shared Web Lock, then release first's rollback.
    await second.waitForTimeout(50);
    await first.evaluate(() => (globalThis as Win & { __resume?: () => void }).__resume?.());
    const raced = await renamePromise;
    const huge = await first.evaluate(() => (globalThis as Win).__huge);
    const after = await second.evaluate(async () => {
      const items = await (await (globalThis as Win).__store).loadAll();
      return { ids: items.map((i) => i.id).sort(), title: items.find((i) => i.id === 'r2')?.title };
    });
    expect(raced.evicting).toBe(true);
    expect(raced.renamed).toEqual({ ok: true, evicted: [] });
    expect(huge).toEqual({ ok: false, evicted: [] });
    expect(after).toEqual({ ids: ['r1', 'r2', 'r3', 'r4'], title: 'Newer title' });
  } finally {
    await context.close();
    await release.close();
  }
});
