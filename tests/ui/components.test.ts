import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { WaveformFrame } from '../../src/core/export/svg.js';
import { computeMathTrace } from '../../src/core/math.js';
import { analyzePngBytes } from '../../src/core/pipeline.js';
import type { SpectrumResult } from '../../src/core/spectrum.js';
import type { Locale, MathConfig } from '../../src/core/types.js';
import { ProfilePanel, ScaleControls, detectionNotes } from '../../src/ui/components/Controls.js';
import { CropBox, QuadBox } from '../../src/ui/components/CropBox.js';
import { CursorOverlay, CursorReadout, cursorTime, snapZero } from '../../src/ui/components/Cursors.js';
import { EmptyState } from '../../src/ui/components/EmptyState.js';
import { MeasurementsPanel } from '../../src/ui/components/Measurements.js';
import { acceptScale, canStep, parseScale, stepWithin, unitFits } from '../../src/ui/components/ScaleInput.js';
import { ShortcutsModal } from '../../src/ui/components/ShortcutsModal.js';
import { OFFLINE_COPY_URL } from '../../src/ui/components/SourceLinks.js';
import { TopBar } from '../../src/ui/components/TopBar.js';
import { DICTS, formatWarning, t } from '../../src/ui/i18n.js';
import { sample } from '../core/fixtures.js';

const noop = (): void => undefined;

describe('acceptScale', () => {
  test('refuses typos far outside what a scope can show', () => {
    expect(acceptScale(1e-30, 'V')).toBe(false);
    expect(acceptScale(1e-30, 's')).toBe(false);
    expect(acceptScale(5e9, 's')).toBe(false);
    expect(acceptScale(1e-30, 'V²')).toBe(false);
    expect(acceptScale(1e9, 'V²')).toBe(false);
    expect(acceptScale(Number.NaN, 'V')).toBe(false);
    expect(acceptScale(Number.POSITIVE_INFINITY, 'V')).toBe(false);
    expect(acceptScale(null, 'V')).toBe(false);
  });

  test('keeps every normal scale, offset and V² value', () => {
    for (const v of [1e-9, 2e-6, 0.005, 1, 10, 50, 1000]) expect(acceptScale(v, 's')).toBe(true);
    for (const v of [1e-3, 0.5, 2, 5, 100]) expect(acceptScale(v, 'V')).toBe(true);
    for (const v of [1e-20, 5, 1e7]) expect(acceptScale(v, 'V²')).toBe(true);
  });

  test('allows zero and negative values only where they make sense', () => {
    expect(acceptScale(0, 'V')).toBe(false);
    expect(acceptScale(-2, 'V')).toBe(false);
    expect(acceptScale(0, 'V', true)).toBe(true);
    expect(acceptScale(-2.5, 'V', true)).toBe(true);
    expect(acceptScale(-1e6, 'V', true)).toBe(false);
  });
});

describe('scale units', () => {
  test('refuses time units in a volt field and volt units in a time field', () => {
    for (const text of ['5 ms', '2us', '10 ns', '1 s', '1 kHz', '5ms/div']) expect(parseScale(text, 'V')).toBeNull();
    for (const text of ['5 V', '200mV', '50 uV', '1 kHz', '2 mV/div']) expect(parseScale(text, 's')).toBeNull();
    expect(parseScale('5 V', 'V²')).toBeNull();
    expect(parseScale('1 A', 'V')).toBeNull();
  });

  test('keeps plain numbers, prefixes and the matching unit', () => {
    expect(parseScale('200mV', 'V')).toBeCloseTo(0.2);
    expect(parseScale('2 V/div', 'V')).toBe(2);
    expect(parseScale('0.5', 'V')).toBe(0.5);
    expect(parseScale('5m', 'V')).toBeCloseTo(0.005);
    expect(parseScale('5 ms', 's')).toBeCloseTo(0.005);
    expect(parseScale('10 µs/div', 's')).toBeCloseTo(1e-5);
    expect(parseScale('3 V²', 'V²')).toBe(3);
    expect(unitFits('5 div', 's')).toBe(true);
  });
});

describe('scale steppers', () => {
  test('stay inside the range the field accepts', () => {
    expect(stepWithin(1e4, 1, 's')).toBe(1e4);
    expect(stepWithin(5e3, 1, 's')).toBe(1e4);
    expect(stepWithin(1e-12, -1, 'V')).toBe(1e-12);
    expect(stepWithin(1e8, 1, 'V²')).toBe(1e8);
    expect(canStep(1e4, 1, 's')).toBe(false);
    expect(canStep(1e4, -1, 's')).toBe(true);
    expect(canStep(1e-12, -1, 'V')).toBe(false);
    expect(canStep(null, 1, 'V')).toBe(false);
  });

  test('never move the wrong way from a value already outside the range', () => {
    expect(stepWithin(5e4, 1, 's')).toBe(5e4);
    expect(stepWithin(5e4, -1, 's')).toBe(1e4);
    expect(acceptScale(stepWithin(5e4, -1, 's'), 's')).toBe(true);
  });

  test('keep normal 1 2 5 steps', () => {
    expect(stepWithin(1e-3, 1, 's')).toBe(2e-3);
    expect(stepWithin(0.5, -1, 'V')).toBe(0.2);
  });
});

/** A 10 div plot whose center time is a float leftover such as 2.8e-17 s, not exactly 0. */
function noisyFrame(): WaveformFrame {
  return {
    width: 960,
    height: 640,
    x0: 76,
    y0: 56,
    x1: 932,
    y1: 584,
    plotW: 856,
    plotH: 528,
    timeAt: (f) => 0.1 * f * 3 - 0.15,
    voltAt: (_ch, f) => 0.1 * (1 - f) * 3 - 0.15,
  };
}

describe('cursor values', () => {
  test('the plot center reads 0 s, never a float leftover in ps', () => {
    const frame = noisyFrame();
    expect(frame.timeAt(0.5)).not.toBe(0);
    expect(cursorTime(frame, 0.5)).toBe(0);
    expect(cursorTime(frame, 0.75)).toBeCloseTo(0.075, 12);
    expect(snapZero(1e-3, 0.3)).toBe(1e-3);
  });

  test('every cursor slider announces its time or voltage', () => {
    const frame = noisyFrame();
    const cursors = { x1: 0.5, x2: 0.75, y1: 0.5, y2: 0.25, channel: 'C1' as const };
    const html = renderToStaticMarkup(createElement(CursorOverlay, { tx: t('en'), locale: 'en', frame, cursors, onChange: noop }));
    expect(html).toMatch(/aria-label="X1"[^>]*aria-valuetext="0 s"/);
    expect(html).toMatch(/aria-label="Y1"[^>]*aria-valuetext="0 V"/);
    expect(html).toMatch(/aria-label="X2"[^>]*aria-valuetext="75 ms"/);
    expect(html).not.toMatch(/e-\d+/);
  });

  test('the readout shows 0 s for a centered X1', () => {
    const result = analyzePngBytes(sample('sine_schmitt.png'), 'sine_schmitt.png');
    const cursors = { x1: 0.5, x2: 0.75, y1: 0.25, y2: 0.75, channel: 'C1' as const };
    const html = renderToStaticMarkup(
      createElement(CursorReadout, { tx: t('en'), locale: 'en', result, frame: noisyFrame(), cursors, labels: undefined, onChange: noop }),
    );
    expect(html).toContain('<span class="k">X1</span><span class="v num">0 s</span>');
    expect(html).not.toContain('ps');
  });
});

describe('analysis warnings', () => {
  const codes = [
    'mismatched_math_scale',
    'math_low_swing',
    'uncalibrated_timebase',
    'partial_capture',
    'interpolated_cursor_gaps',
    'invalid_sample_rate',
  ];

  test.each(['en', 'fr'] as const)('every math and spectrum warning has a real %s sentence', (locale) => {
    for (const code of codes) {
      const text = formatWarning(code, locale);
      expect(DICTS[locale].fallback[code], code).toBeTruthy();
      expect(text).toBe(DICTS[locale].fallback[code]);
      expect(text).not.toContain('_');
      expect(text).toMatch(/\.$/);
    }
  });

  test.each(['en', 'fr'] as const)('the FFT block lists spectrum warnings as notes in %s', (locale: Locale) => {
    const spectrum = {
      channel: 'C1',
      fundamental: null,
      thdPct: null,
      thdReason: null,
      thdBelowFloor: false,
      harmonics: [],
      warnings: ['uncalibrated_timebase', 'partial_capture', 'partial_capture'],
    } as unknown as SpectrumResult;
    const html = renderToStaticMarkup(createElement(MeasurementsPanel, { tx: t(locale), locale, result: null, spectrum }));
    const notes = html.match(/<p class="note" data-testid="fft-warning">[^<]*<\/p>/g) ?? [];
    expect(notes).toHaveLength(2);
    expect(html).toContain(DICTS[locale].fallback.uncalibrated_timebase!.replace(/'/g, '&#x27;'));
    expect(html).not.toContain('uncalibrated_timebase');
  });

  test.each(['en', 'fr'] as const)('the math card lists math warnings as notes in %s', (locale: Locale) => {
    const result = analyzePngBytes(sample('sine_schmitt.png'), 'sine_schmitt.png');
    const config: MathConfig = { a: 'C1', b: 'C2', op: 'sub' };
    const math = computeMathTrace(result, config);
    expect(math).not.toBeNull();
    const field = { config, result: { ...math!, warnings: ['mismatched_math_scale', 'math_low_swing'] }, onChange: noop };
    const html = renderToStaticMarkup(
      createElement(ScaleControls, { tx: t(locale), locale, result, overrides: {}, disabled: false, onOverrides: noop, math: field }),
    );
    const notes = html.match(/<p class="note" data-testid="math-warning">[^<]*<\/p>/g) ?? [];
    expect(notes).toHaveLength(2);
    expect(html).not.toContain('mismatched_math_scale');
    expect(html).not.toContain('math_low_swing');
  });
});

describe('accessible names', () => {
  test('crop corners are sliders that explain their keys, not buttons', () => {
    const rect = { x: 10, y: 20, width: 300, height: 200 };
    const quad = [
      { x: 10, y: 20 },
      { x: 310, y: 20 },
      { x: 310, y: 220 },
      { x: 10, y: 220 },
    ] as const;
    const common = { tx: t('en'), imageWidth: 400, imageHeight: 300, hDivs: 10, vDivs: 8, onApply: noop, onCancel: noop };
    for (const html of [
      renderToStaticMarkup(createElement(CropBox, { ...common, rect, onChange: noop })),
      renderToStaticMarkup(createElement(QuadBox, { ...common, quad, valid: true, onChange: noop })),
    ]) {
      expect(html).not.toContain('role="button"');
      expect(html.match(/role="slider"/g)).toHaveLength(4);
      expect(html).toMatch(/role="slider"[^>]*aria-label="Bottom right corner"[^>]*aria-valuetext="x 310, y 220"/);
      expect(html).toContain('Arrow keys move it');
    }
  });

  test('the mode chip has no ignored aria-label and still reads its name', () => {
    const html = renderToStaticMarkup(
      createElement(TopBar, { tx: t('fr'), mode: 'bode', locale: 'fr', dark: false, onLocale: noop, onTheme: noop, onAdd: noop }),
    );
    expect(html).not.toMatch(/class="mode"[^>]*aria-label/);
    expect(html).toContain('<span class="sr-only">Mode </span>Série Bode');
  });

  test.each(['en', 'fr'] as const)('the shortcuts list covers crop and cursor keys in %s', (locale) => {
    const tx = t(locale);
    const html = renderToStaticMarkup(createElement(ShortcutsModal, { tx, onClose: noop }));
    for (const key of [tx.keyCropKeys, tx.keyArrows, tx.keyShiftArrows, tx.keyEnds]) expect(html).toContain(`<kbd>${key}</kbd>`);
    for (const label of [tx.shortcutCropKeys, tx.shortcutMoveKeys, tx.shortcutBigSteps, tx.shortcutEnds]) {
      expect(html).toContain(label);
    }
  });
});

describe('Hantek detected grid', () => {
  const base = {
    profileId: 'universal-fallback' as const,
    profileName: 'Universal Fallback',
    matchedAnchors: [],
    confidence: 0,
    grid: {} as never,
    digitalOnly: false,
  };

  test.each(['unsupported_resolution', 'native_anchors_mismatch'])('replaces %s with a clear message', (reason) => {
    const notes = detectionNotes({ ...base, fallbackLayout: 'hantek-800x480', fallbackReason: reason, warnings: [reason] });
    expect(notes).toEqual(['hantek_grid']);
    expect(formatWarning(notes[0]!, 'en')).toBe('Found a Hantek grid. Type the time and volt scales shown on the scope.');
    expect(formatWarning(notes[0]!, 'fr')).toBe('Grille Hantek trouvée. Entrez les échelles de temps et de volts affichées sur l’oscilloscope.');
  });

  test('keeps the generic message without a Hantek grid and keeps a manual crop note', () => {
    expect(detectionNotes({ ...base, fallbackReason: 'native_anchors_mismatch', warnings: ['native_anchors_mismatch'] })).toEqual([
      'native_anchors_mismatch',
    ]);
    expect(detectionNotes({ ...base, fallbackLayout: 'hantek-800x480', fallbackReason: 'manual_crop', warnings: ['manual_crop'] })).toEqual([
      'manual_crop',
    ]);
  });
});

describe('profile badge', () => {
  const detection = {
    profileId: 'universal-fallback' as const,
    profileName: 'Universal Fallback',
    matchedAnchors: [],
    confidence: 0.42,
    grid: {} as never,
    digitalOnly: false,
    warnings: [],
  };
  const render = (locale: Locale, d: object): string =>
    renderToStaticMarkup(
      createElement(ProfilePanel, { tx: t(locale), choice: 'auto', result: { detection: d } as never, onChoice: noop }),
    );

  test('names the fallback profile in the chosen language', () => {
    const fr = render('fr', detection);
    expect(fr).toContain('<span>Universel</span>');
    expect(fr).not.toContain('Universal Fallback');
    expect(render('en', detection)).toContain('<span>Universal</span>');
  });

  test('keeps the real name of a detected scope profile', () => {
    expect(render('fr', { ...detection, profileId: 'siglent-sds1000x-e', profileName: 'Siglent SDS1000X-E' })).toContain(
      '<span>Siglent SDS1000X-E</span>',
    );
  });
});

describe('storage full notice', () => {
  test.each(['en', 'fr'] as const)('exists in %s', (locale) => {
    expect(DICTS[locale].historyFull.length).toBeGreaterThan(20);
  });
});

describe('offline copy link', () => {
  test.each(['en', 'fr'] as const)('sits next to the source link in the empty page and shortcuts list in %s', (locale) => {
    const tx = t(locale);
    for (const html of [
      renderToStaticMarkup(createElement(EmptyState, { tx, onAdd: noop })),
      renderToStaticMarkup(createElement(ShortcutsModal, { tx, onClose: noop })),
    ]) {
      expect(html).toContain(`href="${OFFLINE_COPY_URL}" target="_blank" rel="noopener noreferrer">${tx.offlineCopy}</a>`);
      expect(html.indexOf(tx.sourceCode)).toBeLessThan(html.indexOf(tx.offlineCopy));
      expect(html).not.toMatch(/[•·–—]/);
    }
  });

  test('is hidden in the portable file', () => {
    const g = globalThis as { __GRATICULE_PORTABLE__?: boolean };
    g.__GRATICULE_PORTABLE__ = true;
    try {
      const tx = t('en');
      expect(renderToStaticMarkup(createElement(EmptyState, { tx, onAdd: noop }))).not.toContain(OFFLINE_COPY_URL);
      expect(renderToStaticMarkup(createElement(ShortcutsModal, { tx, onClose: noop }))).not.toContain(OFFLINE_COPY_URL);
    } finally {
      delete g.__GRATICULE_PORTABLE__;
    }
  });
});

describe('wording', () => {
  test('English spells recognized like analyzed, French uses the agreed terms', () => {
    expect(JSON.stringify(DICTS.en)).not.toContain('recognised');
    expect(DICTS.fr.modeBode).toBe('Série Bode');
    expect(DICTS.fr.fallback.digital_only).toBe('Seuls des canaux numériques ont été trouvés.');
    expect(DICTS.fr.fallback.manual_profile).toBe('Mode universel choisi à la main.');
    expect(DICTS.en.tooManyImages(50, 3)).toBe('Only the first 50 images were added. 3 images were left out.');
    expect(DICTS.fr.tooManyImages(50, 1)).toBe('Seules les 50 premières images ont été ajoutées. 1 image a été laissée de côté.');
  });
});
