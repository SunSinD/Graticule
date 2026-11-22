import fs from 'node:fs';
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
  expect(source).toMatch(/CACHE_NAME = 'graticule-v1\.1\.1-[a-f0-9]{8}'/);
  expect(source).toMatch(/"\.\/assets\/[^"]+"/);
  expect(source).toMatch(/\.\/assets\/extract\.worker-[^"]+\.js/);
  expect(source).toMatch(/\.\/assets\/pipeline-[^"]+\.js/);
});
