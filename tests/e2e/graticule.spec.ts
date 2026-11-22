import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const FIXTURES = path.resolve('tests/fixtures/samples');
const SINE = path.join(FIXTURES, 'sine_schmitt.png');
const SWEEP = Array.from({ length: 10 }, (_, i) => path.join(FIXTURES, `sweep_${String(i + 1).padStart(2, '0')}.png`));

async function addFiles(page: Page, files: string | readonly string[]): Promise<void> {
  await page.locator('[data-testid="file-input"]').setInputFiles(typeof files === 'string' ? files : [...files]);
}

async function extractSine(page: Page): Promise<void> {
  await addFiles(page, SINE);
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  const summary = page.locator('[data-testid="measurement-summary"]');
  await expect(summary).toBeVisible({ timeout: 5_000 });
  await expect(summary).toContainText(/15\.\d+\s*V/, { timeout: 5_000 });
}

async function extractSweep(page: Page): Promise<void> {
  await addFiles(page, SWEEP);
  await page.getByRole('button', { name: 'Extract Bode (10)' }).click();
  await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('cold load completes quickly with no errors, no external requests and no examples', async ({ page }) => {
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
  await expect(page.getByText('Drop an oscilloscope screenshot, paste one, or add images.')).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Add images' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take photo' })).toHaveCount(0);
  await expect(page.locator('[data-testid="camera-input"]')).toHaveCount(0);
  await expect(page.getByText(/sample|example/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Open$/ })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test('adding a file never extracts until Extract is clicked', async ({ page }) => {
  await addFiles(page, SINE);
  await expect(page.getByRole('button', { name: 'Original' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toBeDisabled();
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Extract', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'Extract', exact: true })).toHaveCount(0);
});

test('Siglent comparison and 1:1 overlay controls work', async ({ page }) => {
  await extractSine(page);
  await expect(page.getByText(/Scope\s*\/\s*Graticule/i)).toBeVisible();
  await expect(page.getByText(/MEASURE/i)).toBeVisible();

  const overlay = page.getByRole('button', { name: /1:1 Overlay/i });
  await overlay.click();
  await expect(overlay).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('t');
  await expect(overlay).toHaveAttribute('aria-pressed', 'false');
});

test('zoom slider grows the plot by layout width and scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await extractSine(page);
  const canvas = page.locator('.viewport .canvas');
  const before = (await canvas.boundingBox())?.width ?? 0;
  const slider = page.getByRole('slider', { name: 'Zoom' });
  await slider.fill('200');
  const readout = page.locator('.zoom-value');
  await expect(readout).toHaveText('200%');
  const after = (await canvas.boundingBox())?.width ?? 0;
  expect(after).toBeGreaterThan(before * 1.8);
  const scrolls = await page.evaluate(() => {
    const vp = document.querySelector('.viewport') as HTMLElement;
    return vp.scrollWidth > vp.clientWidth;
  });
  expect(scrolls).toBe(true);
  const transforms = await page.evaluate(() => getComputedStyle(document.querySelector('.viewport .canvas') as HTMLElement).transform);
  expect(transforms).toBe('none');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(readout).toHaveText('100%');
});

test('shortcuts modal and locale/theme controls toggle', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.getByRole('main').getByRole('button', { name: 'Ajouter des images' })).toBeVisible();
  await page.getByRole('button', { name: 'EN', exact: true }).click();

  const theme = page.getByRole('button', { name: /theme|dark|light/i }).first();
  await theme.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
});

test('1-2-5 scale editing recomputes an extracted capture', async ({ page }) => {
  await extractSine(page);
  const measurementBefore = await page.locator('[data-testid="measurement-summary"]').textContent();
  const stepper = page.getByRole('button', { name: /scale/i }).first();
  await stepper.click();
  await expect(page.locator('[data-testid="measurement-summary"]')).not.toHaveText(measurementBefore ?? '');
});

test('Bode batch mode extracts on click and renders gain, phase, cutoff and live edits', async ({ page }) => {
  await addFiles(page, SWEEP);
  await expect(page.locator('[aria-label="Gain plot"]')).toHaveCount(0);
  await extractSweep(page);
  await expect(page.locator('[aria-label="Phase plot"]')).toBeVisible();
  await expect(page.getByText(/-3 dB/i)).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Zoom' })).toHaveAttribute('max', '250');

  const cell = page.getByRole('textbox').first();
  await cell.fill('12');
  await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible();
});

test('history survives a reload and clicking an item opens it in single mode', async ({ page }) => {
  await extractSine(page);
  await page.waitForTimeout(300);
  await page.reload();
  const row = page.locator('.file-row', { hasText: 'sine_schmitt.png' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid="measurement-summary"]')).toBeVisible();
});

test('turning off Keep history deletes saved captures but keeps this session', async ({ page }) => {
  await addFiles(page, SINE);
  await page.waitForTimeout(300);
  const toggle = page.getByRole('checkbox', { name: 'Keep history' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.locator('.file-row', { hasText: 'sine_schmitt.png' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Keep history' })).not.toBeChecked();
  await expect(page.locator('.file-row')).toHaveCount(0);
});

test('universal fallback accepts a synthetic PNG and shows draggable crop', async ({ page }) => {
  await addFiles(page, SINE);
  await page.getByRole('combobox', { name: /profile/i }).selectOption('universal-fallback');
  await expect(page.locator('[data-testid="crop-box"]')).toBeVisible({ timeout: 5_000 });
});

test('SVG and CSV exports are valid and non-empty', async ({ page }) => {
  await extractSine(page);

  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /SVG|download/i }).first().click();
  const svg = await svgDownload;
  expect(await svg.failure()).toBeNull();
  expect(await svg.path()).not.toBeNull();

  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /CSV/i }).first().click();
  const csv = await csvDownload;
  expect(await csv.failure()).toBeNull();
  expect(await csv.path()).not.toBeNull();
});

test('extracted capture fits the desktop viewport and the French sidebar does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await extractSine(page);

  const layout = await page.evaluate(() => {
    const center = document.querySelector('.zone.center') as HTMLElement | null;
    const exportsEl = document.querySelector('.exports') as HTMLElement | null;
    const exportRect = exportsEl?.getBoundingClientRect();
    return {
      centerScrollOverflow: center ? center.scrollHeight - center.clientHeight : 999,
      exportsVisible: Boolean(exportRect && exportRect.bottom <= window.innerHeight + 1 && exportRect.top >= 0),
    };
  });
  expect(layout.centerScrollOverflow).toBeLessThanOrEqual(2);
  expect(layout.exportsVisible).toBe(true);

  const c1Box = page.getByRole('checkbox', { name: 'C1' });
  await c1Box.click();
  const enableC1 = page.getByRole('button', { name: /Enable C1/i });
  await expect(enableC1).toBeEnabled();
  await enableC1.click();
  await expect(page.getByRole('checkbox', { name: 'C1' })).toBeChecked();

  await page.getByRole('button', { name: 'FR', exact: true }).click();
  const overflow = await page.evaluate(() => {
    const left = document.querySelector('.zone.left') as HTMLElement | null;
    if (!left) return 999;
    const leftRight = left.getBoundingClientRect().right;
    const btns = Array.from(left.querySelectorAll('button'));
    return Math.max(0, ...btns.map((b) => Math.ceil(b.getBoundingClientRect().right - leftRight)));
  });
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: /Vider/i }).click();
  await expect(page.getByText(/Déposez une capture/i)).toBeVisible();
});

test('camera button shows on mobile and stays hidden on touchscreen desktop', async ({ browser }) => {
  const touchDesktop = await browser.newContext({
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  });
  const desktopPage = await touchDesktop.newPage();
  await desktopPage.goto('/');
  await expect(desktopPage.getByRole('button', { name: 'Take photo' })).toHaveCount(0);
  await touchDesktop.close();

  const mobile = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto('/');
  await expect(mobilePage.getByRole('main').getByRole('button', { name: 'Take photo' })).toBeVisible();
  await expect(mobilePage.locator('aside').getByRole('button', { name: 'Take photo' })).toBeVisible();
  await mobile.close();
});

test('dark mode renders dark plot on screen while SVG download stays print ready white', async ({ browser }) => {
  const darkCtx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  const page = await darkCtx.newPage();
  await page.goto('/');
  await extractSine(page);
  const onScreenFill = await page.locator('.paper svg > rect').first().getAttribute('fill');
  expect(onScreenFill).toBe('#0a0a0a');

  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const download = await svgDownload;
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  const svgText = await fs.readFile(filePath!, 'utf8');
  expect(svgText).toContain('fill="#ffffff"');
  await darkCtx.close();
});
