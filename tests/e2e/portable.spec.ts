import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';

const root = path.resolve('.');
const portable = path.resolve(root, 'dist-portable/graticule-portable.html');
const sample = path.resolve(root, 'tests/fixtures/samples/sine_schmitt.png');

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

  await page.goto(pathToFileURL(portable).href);
  await page.locator('[data-testid="file-input"]').setInputFiles(sample);
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await context.close();
});

test('preview serves the manifest and service worker source', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect(JSON.parse(await manifest.text()).name).toBeTruthy();

  const serviceWorker = await request.get('/sw.js');
  expect(serviceWorker.ok()).toBe(true);
  expect(await serviceWorker.text()).toContain("CACHE_NAME = 'graticule-v1.1.0'");
});
