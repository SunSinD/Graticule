import fs from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { test, expect, type Page } from '@playwright/test';

const FIXTURES = path.resolve('tests/fixtures/samples');
const SINE = path.join(FIXTURES, 'sine_schmitt.png');
const SWEEP = Array.from({ length: 10 }, (_, i) => path.join(FIXTURES, `sweep_${String(i + 1).padStart(2, '0')}.png`));
const PHONE = {
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

interface FilePayload {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

async function addFiles(page: Page, files: string | readonly string[] | readonly FilePayload[]): Promise<void> {
  const input = page.locator('[data-testid="file-input"]');
  if (typeof files === 'string') await input.setInputFiles(files);
  else if (files.every((f): f is string => typeof f === 'string')) await input.setInputFiles([...(files as readonly string[])]);
  else await input.setInputFiles([...(files as readonly FilePayload[])]);
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
  await expect(page.getByRole('button', { name: 'Extract', exact: true })).toBeEnabled();
  await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toHaveCount(0);
  await expect(page.locator('.stage img')).toBeVisible();

  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'Extract', exact: true })).toHaveCount(0);
});

test('Siglent comparison and 1:1 overlay controls work', async ({ page }) => {
  await extractSine(page);
  await expect(page.getByText(/Scope\s*\/\s*Graticule/i)).toBeVisible();
  await expect(page.getByText(/MEASURE/i)).toBeVisible();

  const overlay = page.getByRole('button', { name: 'Overlay', exact: true });
  await expect(overlay).toHaveAttribute('title', '1:1 Overlay (T)');
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
  await page.getByRole('button', { name: 'Reset zoom' }).click();
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
  await expect(page.getByRole('button', { name: 'Extract Bode (10)' })).toBeVisible();
  await expect(page.locator('[aria-label="Gain plot"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Extract Bode (10)' }).click();
  await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[aria-label="Phase plot"]')).toBeVisible();
  await expect(page.getByText(/-3 dB/i)).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Zoom' })).toHaveAttribute('max', '250');

  const cell = page.getByRole('textbox', { name: /Frequency/ }).first();
  await cell.fill('12');
  await expect(page.locator('.bode-table .tag')).toHaveCount(0);
  await cell.press('Escape');
  await expect(page.locator('.bode-table .tag')).toHaveCount(0);
  const gain = page.getByRole('textbox', { name: /Gain dB/ }).first();
  await gain.fill('-1');
  await gain.press('Enter');
  await expect(page.locator('.bode-table .tag').first()).toBeVisible();
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

  await page.getByRole('button', { name: 'Vider', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmer ?' }).click();
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

  const mobile = await browser.newContext(PHONE);
  const mobilePage = await mobile.newPage();
  await mobilePage.goto('/');
  await expect(mobilePage.getByRole('main').getByRole('button', { name: 'Take photo' })).toBeVisible();
  await expect(mobilePage.locator('header').getByRole('button', { name: 'Take photo' })).toHaveCount(0);
  await addFiles(mobilePage, SINE);
  await expect(mobilePage.locator('aside').getByRole('button', { name: 'Take photo' })).toBeVisible();
  await expect(mobilePage.locator('header').getByRole('button', { name: 'Add', exact: true })).toBeVisible();
  await expect(mobilePage.locator('header').getByRole('button', { name: 'Take photo' })).toBeVisible();
  const header = await mobilePage.locator('header').boundingBox();
  expect(header?.height ?? 999).toBeLessThan(60);
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

async function paddedSine(page: Page): Promise<FilePayload> {
  const src = (await fs.readFile(SINE)).toString('base64');
  const out = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth + 70;
    canvas.height = img.naturalHeight + 50;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 35, 25);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, src);
  return { name: 'padded_capture.png', mimeType: 'image/png', buffer: Buffer.from(out, 'base64') };
}

async function layoutReport(page: Page) {
  return page.evaluate(() => {
    const center = document.querySelector('.zone.center') as HTMLElement;
    const exportsEl = document.querySelector('.exports') as HTMLElement;
    const r = exportsEl.getBoundingClientRect();
    const buttons = Array.from(exportsEl.querySelectorAll('button'));
    const toolbar = document.querySelector('.capture > .toolbar') as HTMLElement;
    const tops = Array.from(toolbar.children).map((c) => {
      const box = (c as HTMLElement).getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    });
    return {
      centerOverflow: center.scrollHeight - center.clientHeight,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      exportsVisible: r.top >= 0 && r.bottom <= window.innerHeight + 1,
      clipped: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent),
      toolbarRows: Math.max(...tops) - Math.min(...tops),
    };
  });
}

const inDialog = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));

test('auto detected universal captures can dismiss the crop box and show the clean plot', async ({ page }) => {
  await addFiles(page, [await paddedSine(page)]);
  await page.getByRole('button', { name: 'Extract', exact: true }).click();
  const crop = page.locator('[data-testid="crop-box"]');
  await expect(crop).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.badge')).toContainText(/Universal/i);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(crop).toHaveCount(0);
  await page.getByRole('button', { name: 'Clean Plot' }).click();
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.paper svg').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crop', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Original', exact: true }).click();
  const cropToggle = page.getByRole('button', { name: 'Crop', exact: true });
  await cropToggle.click();
  await expect(crop).toBeVisible();
  await cropToggle.click();
  await expect(crop).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Profile' })).toHaveValue('auto');
});

test('measurement cursors toggle with C, move with the keyboard and go into the SVG export', async ({ page }) => {
  await extractSine(page);
  await page.keyboard.press('c');
  const readout = page.locator('[data-testid="cursor-readout"]');
  await expect(readout).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cursors' })).toHaveAttribute('aria-pressed', 'true');
  for (const label of ['X1', 'X2', 'Δt', '1/Δt', 'Y1', 'Y2', 'ΔV']) await expect(readout).toContainText(label);
  await expect(page.getByRole('slider', { name: /^[XY][12]$/ })).toHaveCount(4);

  const before = await readout.textContent();
  const x1 = page.getByRole('slider', { name: 'X1' });
  await x1.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(x1).toHaveAttribute('aria-valuenow', '30');
  await expect(readout).not.toHaveText(before ?? '');

  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const svgText = await fs.readFile((await (await svgDownload).path())!, 'utf8');
  expect(svgText).toContain('X1 / X2 / Y1 / Y2');

  await page.getByRole('button', { name: 'Cursors' }).click();
  await expect(readout).toHaveCount(0);
  await expect(page.locator('[data-testid="cursor-layer"]')).toHaveCount(0);
  await page.locator('h2', { hasText: 'Profile' }).click();
  await page.keyboard.press('c');
  await expect(readout).toBeVisible();
});

test('crop switches between rectangle and 4 corners and applies a perspective box', async ({ page }) => {
  await extractSine(page);
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rectangle' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid="crop-box"]')).toBeVisible();

  await page.getByRole('button', { name: '4 corners' }).click();
  await expect(page.getByRole('button', { name: '4 corners' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid="quad-box"]')).toBeVisible();
  await expect(page.locator('[data-testid="quad-box"] .crop-handle')).toHaveCount(4);
  await expect(page.locator('.quad-line').first()).toBeAttached();

  const apply = page.getByRole('button', { name: 'Apply crop' });
  await expect(apply).toBeEnabled();
  const tl = page.getByRole('button', { name: 'Top left corner' });
  await tl.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.locator('[data-testid="quad-box"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toBeEnabled({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await expect(page.getByRole('button', { name: '4 corners' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Bottom right corner' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="quad-box"]')).toHaveCount(0);
});

test('title, channel label, LaTeX table and plot copy go into the exports', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await extractSine(page);

  const title = page.getByRole('textbox', { name: 'Title' });
  await expect(title).toHaveAttribute('placeholder', 'sine_schmitt.png');
  await title.fill('Lab 3 Schmitt trigger');
  await title.press('Enter');
  const label = page.getByRole('textbox', { name: 'Label C1' });
  await label.fill('Vin');
  await label.press('Enter');
  await expect(page.locator('[data-testid="measurement-summary"] thead')).toContainText('Vin');

  await page.getByRole('button', { name: 'LaTeX' }).click();
  await expect(page.locator('[data-testid="export-feedback"]')).toHaveText('Copied');
  const latex = await page.evaluate(() => navigator.clipboard.readText());
  expect(latex).toContain('\\begin{tabular}');
  expect(latex).toContain('Vin');

  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const svgText = await fs.readFile((await (await svgDownload).path())!, 'utf8');
  expect(svgText).toContain('Lab 3 Schmitt trigger');
  expect(svgText).toContain('Vin');

  await page.locator('h2', { hasText: 'Profile' }).click();
  await page.keyboard.press('Control+c');
  await expect(page.locator('[data-testid="export-feedback"]')).toHaveText('Plot copied', { timeout: 10_000 });
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => [...i.types]));
  expect(types).toContain('image/png');

  await page.waitForTimeout(300);
  await page.reload();
  await page.locator('.file-row', { hasText: 'sine_schmitt.png' }).click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Lab 3 Schmitt trigger');
  await expect(page.getByRole('textbox', { name: 'Label C1' })).toHaveValue('Vin');
});

test('Clear asks for confirmation before wiping the history', async ({ page }) => {
  await addFiles(page, SINE);
  const row = page.locator('.file-row', { hasText: 'sine_schmitt.png' });
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(row).toBeVisible();
  await page.locator('.zone.left').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm clear?' }).click();
  await expect(page.locator('.file-row')).toHaveCount(0);
  await expect(page.getByText('Drop an oscilloscope screenshot, paste one, or add images.')).toBeVisible();
});

test('removing a Bode item that leaves one selected opens it', async ({ page }) => {
  await addFiles(page, SWEEP.slice(0, 2));
  await expect(page.getByRole('button', { name: 'Extract Bode (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove sweep_01.png' }).click();
  await expect(page.getByRole('button', { name: 'Extract', exact: true })).toBeVisible();
  await expect(page.locator('.file-row[aria-current="true"]')).toContainText('sweep_02.png');
});

test('desktop 1440x900 fits in English and French with cursors and every export button', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await extractSine(page);
  await page.keyboard.press('c');
  await expect(page.locator('[data-testid="cursor-readout"]')).toBeVisible();

  const en = await layoutReport(page);
  expect(en.centerOverflow).toBeLessThanOrEqual(2);
  expect(en.pageOverflow).toBeLessThanOrEqual(0);
  expect(en.exportsVisible).toBe(true);
  expect(en.clipped).toEqual([]);
  expect(en.toolbarRows).toBeLessThanOrEqual(2);
  const readoutHeight = await page.locator('[data-testid="cursor-readout"]').evaluate((el) => el.getBoundingClientRect().height);
  expect(readoutHeight).toBeLessThan(40);
  await expect(page.locator('header').getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Curseurs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Calque', exact: true })).toHaveAttribute('title', 'Superposition 1:1 (T)');
  await expect(page.getByRole('group', { name: 'Langue' })).toBeVisible();
  for (const name of ['SVG', 'PNG 2x', 'CSV', 'Copier', 'Word', 'Markdown', 'LaTeX', 'TSV']) {
    await expect(page.locator('.exports').getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText('Temps de montée')).toBeVisible();
  const fr = await layoutReport(page);
  expect(fr.centerOverflow).toBeLessThanOrEqual(2);
  expect(fr.pageOverflow).toBeLessThanOrEqual(0);
  expect(fr.exportsVisible).toBe(true);
  expect(fr.clipped).toEqual([]);
  expect(fr.toolbarRows).toBeLessThanOrEqual(2);
});

test('shortcuts dialog keeps keyboard focus inside while open', async ({ page }) => {
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await inDialog(page)).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await inDialog(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

/** Spread between the vertical centers of the visible top bar items, so 0 means one clean row. */
async function headerSpread(page: Page): Promise<number> {
  return page.evaluate(() => {
    const centers = Array.from(document.querySelectorAll('header > *'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => r.top + r.height / 2);
    return Math.max(...centers) - Math.min(...centers);
  });
}

test('phone empty state hides dead panels, centers French buttons and keeps one top bar row', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'FR', exact: true }).click();

  await expect(page.getByText('Ajoutez une capture d’oscilloscope ou prenez une photo.')).toBeVisible();
  await expect(page.locator('.zone.right')).toBeHidden();
  await expect(page.locator('.zone.left')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Raccourcis clavier' })).toHaveCount(0);
  await expect(page.locator('.mode')).toHaveCount(0);
  expect(await headerSpread(page)).toBeLessThanOrEqual(2);

  const offsets = await page.evaluate(() => {
    const card = document.querySelector('.empty')!.getBoundingClientRect();
    const mid = card.left + card.width / 2;
    return Array.from(document.querySelectorAll('.empty .btn-row .btn')).map((b) => {
      const r = b.getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - mid);
    });
  });
  expect(offsets).toHaveLength(2);
  for (const off of offsets) expect(off).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  await addFiles(page, SINE);
  await expect(page.getByRole('button', { name: 'Extraire', exact: true })).toBeVisible();
  await expect(page.locator('.zone.right')).toBeVisible();
  await expect(page.locator('.zone.left')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Raccourcis clavier' })).toHaveCount(0);
  expect(await headerSpread(page)).toBeLessThanOrEqual(2);
  await ctx.close();
});

test('touch drag moves X1 on a phone without a pointercancel', async ({ browser }) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto('/');
  await extractSine(page);
  await page.getByRole('button', { name: 'Cursors' }).click();
  const x1 = page.getByRole('slider', { name: 'X1' });
  await expect(x1).toHaveAttribute('aria-valuenow', '25');
  await x1.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const w = window as unknown as { cancels: number };
    w.cancels = 0;
    document.querySelector('[data-testid="cursor-layer"]')!.addEventListener('pointercancel', () => w.cancels++, true);
  });

  const line = await x1.locator('.cursor-hit').boundingBox();
  const layer = await page.locator('[data-testid="cursor-layer"]').boundingBox();
  expect(line && layer).toBeTruthy();
  const x = line!.x + line!.width / 2;
  const y = line!.y + line!.height / 2;
  const cdp = await ctx.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y, id: 1 }] });
  await touch('touchStart', x);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x + (layer!.width * 0.2 * i) / 8);
  await touch('touchEnd', x);

  const now = Number(await x1.getAttribute('aria-valuenow'));
  expect(now).toBeGreaterThan(35);
  expect(await page.evaluate(() => (window as unknown as { cancels: number }).cancels)).toBe(0);
  await ctx.close();
});

test('Escape in the title field cancels the draft without saving it', async ({ page }) => {
  await extractSine(page);
  const title = page.getByRole('textbox', { name: 'Title' });
  await title.fill('Draft that should vanish');
  await title.press('Escape');
  await expect(title).toHaveValue('');
  await expect(title).not.toBeFocused();
  await title.focus();
  await page.locator('h2', { hasText: 'Profile' }).click();
  await expect(title).toHaveValue('');
  await expect(page.locator('.paper svg').first()).not.toContainText('Draft that should vanish');

  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const download = await svgDownload;
  expect(download.suggestedFilename()).toBe('sine_schmitt.svg');
  const svgText = await fs.readFile((await download.path())!, 'utf8');
  expect(svgText).not.toContain('Draft that should vanish');

  await title.fill('Lab 3: Schmitt?');
  await title.press('Enter');
  const named = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  expect((await named).suggestedFilename()).toBe('Lab 3_ Schmitt_.csv');
});

test('unticking or removing Bode captures opens the one left, never the capture opened before', async ({ page }) => {
  await addFiles(page, SWEEP.slice(0, 3));
  await expect(page.getByRole('button', { name: 'Extract Bode (3)' })).toBeVisible();
  await page.locator('.file-row', { hasText: 'sweep_01.png' }).click();
  await expect(page.locator('.file-row[aria-current="true"]')).toContainText('sweep_01.png');

  const tick = (name: string) => page.getByRole('checkbox', { name: `Select ${name}` });
  await tick('sweep_02.png').check();
  await tick('sweep_03.png').check();
  await expect(page.getByRole('button', { name: 'Extract Bode (2)' })).toBeVisible();
  await tick('sweep_03.png').uncheck();
  await expect(page.getByRole('button', { name: 'Extract', exact: true })).toBeVisible();
  await expect(page.locator('.file-row[aria-current="true"]')).toContainText('sweep_02.png');

  await page.locator('.file-row', { hasText: 'sweep_01.png' }).click();
  await tick('sweep_02.png').check();
  await tick('sweep_03.png').check();
  await expect(page.getByRole('button', { name: 'Extract Bode (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove sweep_03.png' }).click();
  await expect(page.getByRole('button', { name: 'Extract', exact: true })).toBeVisible();
  await expect(page.locator('.file-row[aria-current="true"]')).toContainText('sweep_02.png');
});

const SMALL_PHONE = { ...PHONE, viewport: { width: 360, height: 640 } };

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  expect(box).toBeTruthy();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test('with cursors on a small phone, swiping empty plot scrolls the page and dragging X1 moves it', async ({ browser }) => {
  const ctx = await browser.newContext(SMALL_PHONE);
  const page = await ctx.newPage();
  await page.goto('/');
  await extractSine(page);
  await page.getByRole('button', { name: 'Cursors' }).click();
  const x1 = page.getByRole('slider', { name: 'X1' });
  await expect(x1).toHaveAttribute('aria-valuenow', '25');

  await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="cursor-layer"]')!.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + layer.top - 60);
    const w = window as unknown as { cancels: number };
    w.cancels = 0;
    document.querySelector('[data-testid="cursor-layer"]')!.addEventListener('pointercancel', () => w.cancels++, true);
  });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });

  const vx1 = await centerOf(page, '[aria-label="X1"] .cursor-hit');
  const vx2 = await centerOf(page, '[aria-label="X2"] .cursor-hit');
  const hy1 = await centerOf(page, '[aria-label="Y1"] .cursor-hit');
  const hy2 = await centerOf(page, '[aria-label="Y2"] .cursor-hit');
  const empty = { x: (vx1.x + vx2.x) / 2, y: (hy1.y + hy2.y) / 2 };
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.cursor') === null, empty);
  expect(hit).toBe(true);

  const before = await page.evaluate(() => window.scrollY);
  await touch('touchStart', empty.x, empty.y);
  for (let i = 1; i <= 10; i++) await touch('touchMove', empty.x, empty.y - 15 * i);
  await touch('touchEnd', empty.x, empty.y);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 40);
  await expect(x1).toHaveAttribute('aria-valuenow', '25');

  await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="cursor-layer"]')!.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + layer.top - 60);
  });
  const line = await centerOf(page, '[aria-label="X1"] .cursor-hit');
  const layer = await page.locator('[data-testid="cursor-layer"]').boundingBox();
  await touch('touchStart', line.x, line.y);
  for (let i = 1; i <= 8; i++) await touch('touchMove', line.x + (layer!.width * 0.2 * i) / 8, line.y);
  await touch('touchEnd', line.x, line.y);
  expect(Number(await x1.getAttribute('aria-valuenow'))).toBeGreaterThan(35);
  expect(await page.evaluate(() => (window as unknown as { cancels: number }).cancels)).toBe(0);
  await ctx.close();
});

test('the 4 corners warning gets a wide row in French on phones and narrow screens', async ({ browser }) => {
  const ctx = await browser.newContext(SMALL_PHONE);
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await addFiles(page, SINE);
  await page.getByRole('button', { name: 'Recadrer', exact: true }).click();
  await page.getByRole('button', { name: '4 coins' }).click();
  const corner = page.getByRole('button', { name: 'Coin haut gauche' });
  await corner.focus();
  const alert = page.locator('.crop-bar [role="alert"]');
  for (let i = 0; i < 150 && (await alert.count()) === 0; i++) await page.keyboard.press('Shift+ArrowDown');
  await expect(alert).toContainText('convexe');
  for (const size of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 1001, height: 768 }]) {
    await page.setViewportSize(size);
    const width = await alert.evaluate((el) => el.getBoundingClientRect().width);
    expect(width, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
  await ctx.close();
});

test('Escape closes the crop box while the Crop button still has focus', async ({ page }) => {
  await extractSine(page);
  await page.keyboard.press('1');
  const crop = page.getByRole('button', { name: 'Crop', exact: true });
  await crop.click();
  await expect(page.locator('[data-testid="crop-box"]')).toBeVisible();
  await expect(crop).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="crop-box"]')).toHaveCount(0);
  await expect(crop).toHaveAttribute('aria-pressed', 'false');
});

test('inspecting a Bode point focuses Back, and going back focuses that point again', async ({ page }) => {
  await extractSweep(page);
  const point = page.locator('.bode-table td.file .linklike').nth(2);
  const name = (await point.textContent()) ?? '';
  await point.click();
  const back = page.getByRole('button', { name: 'Back to Bode' });
  await expect(back).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.bode-table td.file .linklike', { hasText: name })).toBeFocused();
});

async function damagedPng(name: string): Promise<FilePayload> {
  const bytes = Buffer.from(await fs.readFile(SWEEP[0]!));
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(pos);
    if (bytes.toString('latin1', pos + 4, pos + 8) === 'IDAT') {
      for (let i = pos + 8; i < pos + 8 + Math.min(len, 256); i++) bytes[i] = bytes[i]! ^ 0xff;
      break;
    }
    pos += 12 + len;
  }
  return { name, mimeType: 'image/png', buffer: bytes };
}

async function asPayload(file: string): Promise<FilePayload> {
  return { name: path.basename(file), mimeType: 'image/png', buffer: await fs.readFile(file) };
}

test('one unreadable file in a multi file upload keeps the others and names the skipped file', async ({ page }) => {
  const garbage: FilePayload = { name: 'broken_capture.png', mimeType: 'image/png', buffer: Buffer.from('not a png at all') };
  await addFiles(page, [await asPayload(SWEEP[0]!), garbage, await asPayload(SWEEP[1]!)]);
  const note = page.locator('[data-testid="file-note"]');
  await expect(note).toBeVisible();
  await expect(note).toContainText('broken_capture.png');
  await expect(page.locator('.file-row', { hasText: 'sweep_01.png' })).toBeVisible();
  await expect(page.locator('.file-row', { hasText: 'sweep_02.png' })).toBeVisible();
  await expect(page.locator('.file-row', { hasText: 'broken_capture.png' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Extract Bode (2)' })).toBeVisible();

  await addFiles(page, [garbage]);
  await expect(note).toContainText('broken_capture.png');
  await expect(page.locator('.file-row')).toHaveCount(2);
});

test('a damaged PNG in a Bode batch becomes a rejected row that can be inspected and edited', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await addFiles(page, [...(await Promise.all(SWEEP.map(asPayload))), await damagedPng('sweep_11.png')]);
  await page.getByRole('button', { name: 'Extract Bode (11)' }).click();
  await expect(page.locator('[aria-label="Gain plot"]')).toBeVisible({ timeout: 15_000 });
  const row = page.locator('.bode-table tr', { hasText: 'sweep_11.png' });
  await expect(row).toHaveClass(/rej/);
  await expect(row).toContainText('capture could not be read or analyzed');
  await expect(page.locator('.bode-table tr.ok')).not.toHaveCount(0);

  await row.locator('td.file .linklike').click();
  await expect(page.getByRole('button', { name: 'Back to Bode' })).toBeFocused();
  const failed = page.locator('[data-testid="inspect-failed"]');
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('capture could not be read or analyzed');
  for (const name of ['SVG', '2x PNG', 'CSV', 'Copy']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.locator('h2', { hasText: 'Profile' }).click();
  await page.keyboard.press('Control+c');
  await expect(page.locator('[data-testid="export-feedback"]')).toHaveText('');

  await page.getByRole('button', { name: 'Back to Bode' }).click();
  const freq = page.getByRole('textbox', { name: 'sweep_11.png Frequency' });
  await freq.fill('5000');
  await freq.press('Enter');
  const gain = page.getByRole('textbox', { name: 'sweep_11.png Gain dB' });
  await gain.fill('-2');
  await gain.press('Enter');
  await expect(row.locator('.tag')).toBeVisible();
  await expect(gain).toHaveValue(/^-2([.,]0+)?$/);
  await expect(row).toHaveClass(/ok/);
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('coincident cursors show zero for delta t and a dash for 1 over delta t', async ({ page }) => {
  await extractSine(page);
  await page.keyboard.press('c');
  const readout = page.locator('[data-testid="cursor-readout"]');
  await expect(readout).toBeVisible();
  const x1 = page.getByRole('slider', { name: 'X1' });
  await x1.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(x1).toHaveAttribute('aria-valuenow', '75');
  const value = (k: string) => readout.locator('.cursor-item', { has: page.locator('.k', { hasText: new RegExp(`^${k}$`) }) }).locator('.v');
  await expect(value('Δt')).toHaveText(/^0\s*s$/);
  await expect(value('1/Δt')).toHaveText('—');
});

test('a cursor move saved right before a reload is kept', async ({ page }) => {
  await extractSine(page);
  await page.waitForTimeout(300);
  await page.keyboard.press('c');
  const x1 = page.getByRole('slider', { name: 'X1' });
  await x1.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(x1).toHaveAttribute('aria-valuenow', '35');
  await page.waitForTimeout(100);
  await page.reload();
  await page.locator('.file-row', { hasText: 'sine_schmitt.png' }).click();
  await expect(page.getByRole('button', { name: 'Clean Plot' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('c');
  await expect(page.getByRole('slider', { name: 'X1' })).toHaveAttribute('aria-valuenow', '35');
});

test('a custom title goes into the downloaded CSV', async ({ page }) => {
  await extractSine(page);
  const title = page.getByRole('textbox', { name: 'Title' });
  await title.fill('Lab 5 RC filter');
  await title.press('Enter');
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const download = await csvDownload;
  expect(download.suggestedFilename()).toBe('Lab 5 RC filter.csv');
  const csv = await fs.readFile((await download.path())!, 'utf8');
  expect(csv).toContain('# title: Lab 5 RC filter');
  expect(csv).toContain('# file: sine_schmitt.png');
});

const viewTab = (page: Page, name: string) => page.getByRole('group', { name: /^(View|Vue)$/ }).getByRole('button', { name, exact: true });

async function download(page: Page, button: string): Promise<{ name: string; text: string }> {
  const pending = page.waitForEvent('download');
  await page.locator('.exports').getByRole('button', { name: button, exact: true }).click();
  const file = await pending;
  const text = await fs.readFile((await file.path())!, 'utf8');
  return { name: file.suggestedFilename(), text };
}

test('one view switcher holds Original, Overlay, Clean, XY and FFT and follows keys 1 to 5', async ({ page }) => {
  await extractSine(page);
  const group = page.getByRole('group', { name: 'View' });
  await expect(group.getByRole('button')).toHaveText(['Original', 'Overlay', 'Clean', 'XY', 'FFT']);
  await expect(viewTab(page, 'Clean Plot')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Cursors' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crop', exact: true })).toHaveCount(0);

  const steps: readonly (readonly [string, string])[] = [
    ['1', 'Original'],
    ['2', 'Overlay'],
    ['4', 'XY'],
    ['5', 'FFT'],
    ['3', 'Clean Plot'],
  ];
  for (const [key, name] of steps) {
    await page.keyboard.press(key);
    await expect(viewTab(page, name)).toHaveAttribute('aria-pressed', 'true');
  }

  await page.keyboard.press('1');
  await expect(page.getByRole('button', { name: 'Crop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cursors' })).toHaveCount(0);
  await page.keyboard.press('t');
  await expect(viewTab(page, 'Overlay')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.overlay svg')).toBeVisible();
  await page.keyboard.press('c');
  await expect(viewTab(page, 'Clean Plot')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid="cursor-readout"]')).toBeVisible();

  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Vue' }).getByRole('button')).toHaveText(['Original', 'Calque', 'Propre', 'XY', 'FFT']);
  await expect(viewTab(page, 'Calque')).toHaveAttribute('title', 'Superposition 1:1 (T)');
});

test('the + M chip adds a math channel to the plot, the Results and the CSV', async ({ page }) => {
  await extractSine(page);
  await page.getByRole('button', { name: 'Add math channel' }).click();
  await expect(page.getByRole('combobox', { name: 'Math operation' })).toHaveValue('sub');
  await expect(page.getByRole('combobox', { name: 'Math first channel' })).toHaveValue('C1');
  await expect(page.getByRole('combobox', { name: 'Math second channel' })).toHaveValue('C2');
  await expect(page.locator('[data-testid="measurement-summary"] thead')).toContainText('C1 - C2');
  await expect(page.locator('[data-testid="clean-plot"] svg')).toContainText('C1 - C2');
  await expect(page.getByRole('button', { name: 'Add math channel' })).toHaveCount(0);

  const csv = await download(page, 'CSV');
  expect(csv.text).toContain('# M: C1 - C2 C1 sub C2');
  expect(csv.text).toMatch(/,m_v,m_status/);

  await viewTab(page, 'XY').click();
  await expect(page.getByRole('combobox', { name: 'X axis channel' }).locator('option')).toHaveText(['C1', 'C2', 'C1 - C2']);

  await viewTab(page, 'Clean Plot').click();
  await page.getByRole('checkbox', { name: 'Remove math channel' }).click();
  await expect(page.locator('[data-testid="measurement-summary"] thead')).not.toContainText('C1 - C2');
  await expect(page.getByRole('button', { name: 'Add math channel' })).toBeVisible();
});

test('XY view plots, swaps axes and exports XY data, FFT view shows harmonics and switches scale', async ({ page }) => {
  await extractSine(page);
  await viewTab(page, 'XY').click();
  await expect(page.locator('[data-testid="xy-plot"] svg')).toBeVisible();
  const x = page.getByRole('combobox', { name: 'X axis channel' });
  const y = page.getByRole('combobox', { name: 'Y axis channel' });
  await expect(x).toHaveValue('C1');
  await expect(y).toHaveValue('C2');
  await expect(page.locator('[data-testid="xy-summary"]')).toContainText('X range');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(x).toHaveValue('C2');
  await expect(y).toHaveValue('C1');
  await expect(page.locator('.exports').getByRole('button', { name: 'Word', exact: true })).toBeDisabled();

  const xyCsv = await download(page, 'CSV');
  expect(xyCsv.name).toBe('sine_schmitt_xy.csv');
  expect(xyCsv.text).toContain('# x: C2 (V), y: C1 (V)');
  const xySvg = await download(page, 'SVG');
  expect(xySvg.name).toBe('sine_schmitt_xy.svg');
  expect(xySvg.text).toContain('fill="#fff"');

  await viewTab(page, 'FFT').click();
  const plot = page.locator('[data-testid="fft-plot"] svg');
  await expect(plot).toBeVisible();
  await expect(plot).toContainText('dBV');
  const summary = page.locator('[data-testid="fft-summary"]');
  await expect(summary).toContainText('Fundamental');
  await expect(summary.locator('dt', { hasText: /^THD$/ })).toBeVisible();
  await expect(summary).toContainText('Values below the dashed line are pixel noise');
  await expect(summary.locator('dt', { hasText: /^H2$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Lin', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lin', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(plot).toContainText('V RMS');
  await page.getByRole('combobox', { name: 'FFT window' }).selectOption('flattop');
  const fftCsv = await download(page, 'CSV');
  expect(fftCsv.name).toBe('sine_schmitt_fft.csv');
  expect(fftCsv.text).toContain('window=flattop');
  expect(fftCsv.text).toContain('frequency_hz,vrms,dbv');
  await expect(page.locator('.exports').getByRole('button', { name: 'Markdown', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.locator('[data-testid="fft-summary"]')).toContainText('Les valeurs sous la ligne pointillée sont du bruit de pixel');
});

test('selecting captures offers a Bode plot or a zip lab report with every capture', async ({ page }) => {
  await addFiles(page, SWEEP.slice(0, 3));
  await expect(page.getByText('3 captures selected', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Extract Bode (3)' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select sweep_01.png' })).toBeChecked();

  const pending = page.waitForEvent('download', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Export all (.zip)' }).click();
  const zip = await pending;
  expect(zip.suggestedFilename()).toBe('graticule-report.zip');
  const files = unzipSync(new Uint8Array(await fs.readFile((await zip.path())!)));
  const names = Object.keys(files);
  for (const name of ['report.md', 'report.tex', 'report.html']) expect(names).toContain(name);
  for (const n of ['01', '02', '03']) {
    expect(names).toContain(`captures/sweep_${n}.svg`);
    expect(names).toContain(`captures/sweep_${n}.csv`);
  }
  expect(strFromU8(files['report.md']!)).toContain('## sweep');
  await expect(page.locator('[data-testid="export-feedback"]')).toHaveText('Report downloaded');
  await expect(page.locator('.file-row .dot.on')).toHaveCount(3);
});

test('a Bode title names the Bode SVG and CSV downloads', async ({ page }) => {
  await extractSweep(page);
  const title = page.getByRole('textbox', { name: 'Title' });
  await expect(title).toHaveAttribute('placeholder', 'Bode');
  expect((await download(page, 'SVG')).name).toBe('bode.svg');
  await title.fill('Lab 4 RC low pass');
  await title.press('Enter');
  const svg = await download(page, 'SVG');
  expect(svg.name).toBe('Lab 4 RC low pass.svg');
  expect(svg.text).toContain('Lab 4 RC low pass');
  expect((await download(page, 'CSV')).name).toBe('Lab 4 RC low pass.csv');
});

test('desktop empty state hides the right panel and a small phone gets a capture switcher', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('.zone.right')).toBeHidden();
  await addFiles(page, SINE);
  await expect(page.locator('.zone.right')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Capture' })).toHaveCount(0);

  const ctx = await browser.newContext(SMALL_PHONE);
  const phone = await ctx.newPage();
  await phone.goto('/');
  await addFiles(phone, SWEEP.slice(0, 3));
  const switcher = phone.getByRole('combobox', { name: 'Capture' });
  await expect(switcher).toBeVisible();
  const box = await switcher.boundingBox();
  expect(box?.y ?? 999).toBeLessThan(160);
  await switcher.selectOption({ label: 'sweep_02.png' });
  await expect(phone.getByRole('button', { name: 'Extract', exact: true })).toBeVisible();
  await expect(phone.locator('.file-row[aria-current="true"]')).toContainText('sweep_02.png');

  await phone.getByRole('button', { name: 'Extract', exact: true }).click();
  await expect(phone.locator('.paper svg')).toBeVisible({ timeout: 10_000 });
  const settings = phone.locator('details.settings');
  await expect(settings).not.toHaveAttribute('open', '');
  await expect(phone.locator('[data-testid="measurement-summary"]')).toBeVisible();
  await expect(phone.locator('.exports')).toBeVisible();
  await settings.locator('summary').click();
  await expect(phone.getByRole('combobox', { name: 'Profile' })).toBeVisible();
  const status = await phone.locator('.status').boundingBox();
  const plot = await phone.locator('.capture').boundingBox();
  expect(Boolean(status && plot && status.y < plot.y)).toBe(true);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await ctx.close();
});

test('every view fits without sideways scrolling from phone to desktop in English and French', async ({ page }) => {
  await extractSine(page);
  await page.getByRole('button', { name: /theme/i }).click();
  const sizes = [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ];
  for (const locale of ['EN', 'FR']) {
    await page.getByRole('button', { name: locale, exact: true }).click();
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const key of ['1', '3', '4', '5']) {
        await page.keyboard.press(key);
        const report = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          const toolbar = document.querySelector('.capture > .toolbar') as HTMLElement;
          const right = Math.max(...Array.from(toolbar.querySelectorAll('*')).map((el) => el.getBoundingClientRect().right));
          return { page: document.documentElement.scrollWidth - width, toolbar: Math.ceil(right - toolbar.getBoundingClientRect().right) };
        });
        expect(report.page, `${locale} ${size.width}x${size.height} key ${key}`).toBeLessThanOrEqual(0);
        expect(report.toolbar, `${locale} ${size.width}x${size.height} key ${key} toolbar`).toBeLessThanOrEqual(1);
      }
    }
  }
});
