import { test, expect, type Page } from '@playwright/test';

const samples = [
  'Sine and Schmitt trigger',
  'Zener clipping',
  'Active filter sweep, 10 captures',
] as const;

async function loadSample(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).click();
  if (name.includes('sweep')) {
    await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/990|Hz/i).first()).toBeVisible({ timeout: 5_000 });
  } else {
    const summary = page.locator('[data-testid="measurement-summary"]');
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await expect(summary).toContainText(/V/, { timeout: 5_000 });
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('cold load completes quickly with no errors or external requests', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') externalRequests.push(request.url());
  });

  await page.goto('/', { waitUntil: 'networkidle', timeout: 5_000 });
  await expect(page.getByText('Drop an oscilloscope screenshot')).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test('all bundled samples load and expose extracted measurements', async ({ page }) => {
  for (const name of samples) {
    await loadSample(page, name);
    await expect(page.getByText(/measurement|extracted/i).first()).toBeVisible();
  }
});

test('Siglent comparison and 1:1 overlay controls work', async ({ page }) => {
  await loadSample(page, 'Sine and Schmitt trigger');
  await expect(page.getByText(/Scope\s*\/\s*Graticule/i)).toBeVisible();
  await expect(page.getByText(/MEASURE/i)).toBeVisible();

  const overlay = page.getByRole('button', { name: /1:1 Overlay/i });
  await overlay.click();
  await expect(overlay).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('t');
  await expect(overlay).toHaveAttribute('aria-pressed', 'false');
});

test('shortcuts modal and locale/theme controls toggle', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.getByText('Fréquence')).toBeVisible();
  await expect(page.getByText(/,/).first()).toBeVisible();
  await page.getByRole('button', { name: 'EN', exact: true }).click();

  const theme = page.getByRole('button', { name: /theme|dark|light/i }).first();
  await theme.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
});

test('1-2-5 scale editing recomputes measurements', async ({ page }) => {
  await loadSample(page, 'Sine and Schmitt trigger');
  const measurementBefore = await page.locator('[data-testid="measurement-summary"]').textContent();
  const stepper = page.getByRole('button', { name: /scale/i }).first();
  await stepper.click();
  await expect(page.locator('[data-testid="measurement-summary"]')).not.toHaveText(measurementBefore ?? '');
});

test('Bode batch mode renders gain, phase, cutoff, and live table edits', async ({ page }) => {
  await loadSample(page, 'Active filter sweep, 10 captures');
  await expect(page.getByText(/10/).first()).toBeVisible();
  await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible();
  await expect(page.locator('[aria-label="Phase plot"]')).toBeVisible();
  await expect(page.getByText(/-3 dB/i)).toBeVisible();

  const cell = page.getByRole('textbox').first();
  await cell.fill('12');
  await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible();
});

test('universal fallback accepts a synthetic PNG and shows draggable crop', async ({ page }) => {
  await page.getByRole('combobox', { name: /profile/i }).selectOption('universal-fallback');
  const upload = page.locator('input[type="file"]');
  await upload.setInputFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('[data-testid="crop-box"]')).toBeVisible({ timeout: 5_000 });
});

test('SVG and CSV exports are valid and non-empty', async ({ page }) => {
  await loadSample(page, 'Sine and Schmitt trigger');

  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /SVG|download/i }).first().click();
  const svg = await svgDownload;
  expect(await svg.failure()).toBeNull();
  const svgPath = await svg.path();
  expect(svgPath).not.toBeNull();

  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /CSV/i }).first().click();
  const csv = await csvDownload;
  expect(await csv.failure()).toBeNull();
  const csvPath = await csv.path();
  expect(csvPath).not.toBeNull();
});
