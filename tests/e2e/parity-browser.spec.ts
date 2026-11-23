import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect, type Page } from '@playwright/test';

const FIXTURES = path.resolve('tests/fixtures/samples');
const SINE = path.join(FIXTURES, 'sine_schmitt.png');
const ZENER = path.join(FIXTURES, 'zener_clip.png');
const SWEEP = Array.from({ length: 10 }, (_, i) => `sweep_${String(i + 1).padStart(2, '0')}.png`);
const CLI = path.resolve('dist-cli/cli/index.js');
const run = promisify(execFile);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function extractCapture(page: Page, file: string): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(file);
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clean Plot', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
}

async function expectCsvParity(page: Page, cliFile: string): Promise<void> {
  expect(page.workers().map((worker) => worker.url())).toContainEqual(expect.stringMatching(/\/extract\.worker-[^/]+\.js$/));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV', exact: true }).click(),
  ]);
  const [browserCsv, cliCsv] = await Promise.all([fs.readFile(await download.path()), fs.readFile(cliFile)]);
  expect(utf8.decode(browserCsv)).toBe(utf8.decode(cliCsv));
}

test('browser Web Worker CSV matches Node CLI CSV byte-for-byte', async ({ page }) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graticule-parity-'));
  const cliFile = path.join(tempDir, 'cli.csv');
  const sweepFiles = SWEEP.map((file) => path.join(tempDir, file));

  try {
    await page.goto('/');
    await page.getByRole('checkbox', { name: 'Keep history' }).uncheck();
    for (const fixture of [SINE, ZENER]) {
      const name = path.basename(fixture);
      await test.step(name, async () => {
        await run(process.execPath, [CLI, fixture, '--title', name, '--csv', '--out', cliFile]);
        await extractCapture(page, fixture);
        await expectCsvParity(page, cliFile);
        await page.reload();
      });
    }

    await test.step('Ten-capture Bode sweep', async () => {
      for (const file of SWEEP) await fs.copyFile(path.join(FIXTURES, file), path.join(tempDir, file));
      await run(process.execPath, [CLI, '--bode', tempDir, '--csv', '--out', cliFile]);
      await page.getByTestId('file-input').setInputFiles(sweepFiles);
      await page.getByRole('button', { name: 'Extract Bode (10)', exact: true }).click();
      await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible({ timeout: 15_000 });
      await expectCsvParity(page, cliFile);
    });
  } finally {
    await Promise.all([cliFile, ...sweepFiles].map((file) => fs.rm(file, { force: true })));
    await fs.rmdir(tempDir);
  }
});

test('offline reload works reliably once service worker controls the page', async ({ page, context }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await page.evaluate(async () => {
    const workers = navigator.serviceWorker;
    if (!workers.controller) {
      await new Promise<void>((resolve) => {
        workers.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  await context.setOffline(true);
  const response = await page.goto('/?offline-check=1', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  expect(response?.fromServiceWorker()).toBe(true);

  await extractCapture(page, SINE);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
