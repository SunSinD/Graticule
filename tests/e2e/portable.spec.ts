import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';

const root = path.resolve('.');
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

test('preview serves the manifest and fully precached service worker source', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect(JSON.parse(await manifest.text()).name).toBeTruthy();

  const serviceWorker = await request.get('/sw.js');
  expect(serviceWorker.ok()).toBe(true);
  const source = await serviceWorker.text();
  expect(source).toMatch(/CACHE_NAME = 'graticule-v1\.1\.2-[a-f0-9]{8}'/);
  expect(source).toMatch(/"\.\/assets\/[^"]+"/);
  expect(source).toMatch(/\.\/assets\/extract\.worker-[^"]+\.js/);
  expect(source).toMatch(/\.\/assets\/pipeline-[^"]+\.js/);
});
