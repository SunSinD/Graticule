import { describe, expect, test } from 'vitest';
import { analyzeCapture, analyzePngBytes } from '../../src/core/pipeline.js';
import { readScopeMetadata } from '../../src/core/ocr.js';
import { decodePng } from '../../src/core/png.js';
import { detectProfile } from '../../src/core/profiles.js';
import type { ChannelId, ChannelTrace, ExtractionOverrides, RgbaImage } from '../../src/core/types.js';
import { bitmap, magenta, pixel, sample, yellow } from './fixtures.js';
import type { Rgb } from './fixtures.js';

const grid = { x: 10, y: 10, width: 400, height: 200 };
const zero = 110;
const overrides: ExtractionOverrides = {
  manualCrop: grid, secPerDiv: 0.0005,
  channels: { C1: { voltsPerDiv: 1, zeroY: zero }, C2: { voltsPerDiv: 1, zeroY: zero } },
};

function plot(image: RgbaImage, ink: Rgb, fn: (column: number) => number | null, thickness = 1): void {
  for (let col = 0; col <= grid.width; col++) {
    const expected = fn(col);
    if (expected === null) continue;
    const y = Math.min(grid.y + grid.height, Math.max(grid.y, Math.round(expected)));
    for (let offset = -thickness; offset <= thickness; offset++) {
      pixel(image, grid.x + col, Math.min(grid.y + grid.height, Math.max(grid.y, y + offset)), ink);
    }
  }
}

const traceById = (traces: readonly ChannelTrace[], channel: ChannelId) => traces.find(trace => trace.channel === channel)!;

describe('column extraction and waveform measurements', () => {
  test('keeps a flat DC trace inside the automatically detected grid', () => {
    const image = bitmap(421, 221, [190, 190, 190]);
    for (let y = grid.y; y <= grid.y + grid.height; y++) {
      for (let x = grid.x; x <= grid.x + grid.width; x++) pixel(image, x, y, [0, 0, 0]);
    }
    plot(image, yellow, () => 150);
    const result = analyzeCapture(image, 'dc.png');
    expect(result.detection.grid).toMatchObject({ top: 10, bottom: 210, left: 10, right: 410 });
    expect(traceById(result.traces, 'C1').validCount).toBe(401);
  });

  test('retains finite voltages after an intermediate overflow and marks truly overflowing values unresolved', () => {
    const image = bitmap(41, 11);
    for (let x = 0; x < image.width; x++) pixel(image, x, 5, yellow);
    const extract = (voltsPerDiv: number) => analyzeCapture(image, 'large-voltage.png', {
      manualCrop: { x: 0, y: 0, width: 40, height: 10 }, vDivs: 100,
      channels: { C1: { enabled: true, zeroY: 1e308, voltsPerDiv } },
    }).traces[0]!;
    const finite = extract(1e-4);
    expect(finite.samples[20]!.status).toBe('ok');
    expect(finite.samples[20]!.voltage! / 1e305).toBeCloseTo(1, 12);
    const overflowing = extract(1);
    expect(overflowing.validCount).toBe(0);
    expect(overflowing.samples[20]).toMatchObject({ status: 'unresolved', voltage: null, yPx: null });
  });

  test('classifies inverted trace colors in the universal fallback profile', () => {
    const image = bitmap(421, 221, [255, 255, 255]);
    plot(image, [0, 0, 198], col => zero - 33 * Math.sin(2 * Math.PI * col / 80));
    const result = analyzeCapture(image, 'inverted-fallback.png', { ...overrides, profileId: 'universal-fallback' });
    expect(result.detection.grid.inverted).toBe(true);
    expect(result.traces.map(trace => trace.channel)).toEqual(['C1']);
    expect(result.traces[0]!.validCount).toBe(401);
    expect(result.measurements[0]!.frequencyHz).toBeCloseTo(1000, 2);
  });
  test('recovers noisy, 3 px analog sinusoids, frequency and signed phase', () => {
    const image = bitmap(421, 221);
    const wave = (col: number) => zero - 45 * Math.cos(2 * Math.PI * col / 80);
    plot(image, yellow, col => wave(col) + ((col * 23) % 7 - 3) / 3, 1);
    plot(image, magenta, col => zero + 18 - 30 * Math.cos(2 * Math.PI * col / 80 - Math.PI / 4));
    const result = analyzeCapture(image, 'synthetic.png', overrides);
    const c1 = traceById(result.traces, 'C1');
    const errors = c1.samples.flatMap(s => s.status === 'ok' ? [Math.abs(s.yPx! - wave(s.col))] : []).sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length * 0.5)]).toBeLessThanOrEqual(1);
    expect(errors[Math.floor(errors.length * 0.95)]).toBeLessThanOrEqual(2);
    expect(result.measurements[0]!.frequencyHz).toBeCloseTo(1000, 0);
    expect(result.measurements[0]!.vpp).toBeCloseTo(3.68, 8);
    expect(result.measurements[0]!.dutyCyclePct).toBeNull();
    expect(result.phaseC1ToC2?.phaseDeg).toBeCloseTo(-45, 0);
    expect(result.phasePair).toMatchObject({ from: 'C1', to: 'C2', phaseDeg: expect.closeTo(-45, 0) });
    expect(result.phaseC1ToC2?.r2Ref).toBeGreaterThan(0.998);
  });

  test('uses Schmitt hysteresis and reports duty for at least two complete pulse cycles', () => {
    const image = bitmap(421, 221);
    plot(image, yellow, col => (col % 80 < 28 ? 74 : 146) + ((col * 23) % 7 - 3), 2);
    const result = analyzeCapture(image, 'square.png', overrides);
    expect(result.measurements[0]!.frequencyHz).toBeCloseTo(1000, 0);
    expect(result.measurements[0]!.dutyCyclePct).toBeCloseTo(35, 0);
    expect(result.measurements[0]!.completeCycles).toBeGreaterThanOrEqual(3);

    const short = bitmap(421, 221);
    plot(short, yellow, col => col < 16 || col > 280 ? null : col % 160 < 55 ? 70 : 150);
    expect(analyzeCapture(short, 'single-pulse.png', overrides).measurements[0]!.dutyCyclePct).toBeNull();
  });

  test('reports a narrow repeating pulse but withholds a frequency for isolated and irregular bursts', () => {
    const periodic = bitmap(421, 221);
    plot(periodic, yellow, col => col % 80 < 16 ? 74 : 146);
    expect(analyzeCapture(periodic, 'low-duty.png', overrides).measurements[0]).toMatchObject({
      frequencyHz: expect.closeTo(1000, 5), dutyCyclePct: expect.closeTo(20, 5),
    });

    const burst = bitmap(421, 221);
    plot(burst, yellow, col => col >= 172 && col < 268 && (col - 172) % 24 < 9 ? 74 : 146);
    expect(analyzeCapture(burst, 'isolated-burst.png', overrides).measurements[0]).toMatchObject({
      vpp: 2.88, frequencyHz: null, periodSec: null, dutyCyclePct: null,
    });

    const irregular = bitmap(421, 221);
    plot(irregular, yellow, col => col % 80 < (Math.floor(col / 80) % 2 ? 40 : 12) ? 74 : 146);
    expect(analyzeCapture(irregular, 'variable-width.png', overrides).measurements[0]).toMatchObject({
      frequencyHz: null, periodSec: null, dutyCyclePct: null,
    });
  });

  test('marks clipping in both directions and exposes unknown gaps without a voltage', () => {
    const image = bitmap(421, 221);
    plot(image, yellow, col => col >= 153 && col <= 173 ? null : zero - 135 * Math.sin(2 * Math.PI * col / 120));
    const result = analyzeCapture(image, 'clipped.png', overrides);
    const c1 = traceById(result.traces, 'C1');
    expect(c1.clippedCount).toBeGreaterThan(50);
    expect(c1.samples[30]).toMatchObject({ status: 'clipped_high', yPx: null, voltage: null });
    expect(c1.samples[90]).toMatchObject({ status: 'clipped_low', yPx: null, voltage: null });
    expect(c1.samples[160]).toMatchObject({ status: 'unresolved', yPx: null, voltage: null });
    expect(result.measurements[0]!.clipped).toBe(true);
  });

  test('tags cursor occlusion without losing a solid yellow horizontal trace', () => {
    const image = bitmap(421, 221);
    plot(image, yellow, col => col === 180 ? null : 98, 0);
    // A vertical cursor dash covers the trace at column 180.
    for (let y = 10; y <= 210; y++) if ((y - 10) % 8 < 5) pixel(image, 190, y, [255, 255, 0]);
    const c1 = traceById(analyzeCapture(image, 'cursor.png', overrides).traces, 'C1');
    expect(c1.samples[180]).toMatchObject({ status: 'masked_cursor', yPx: null, voltage: null });
    expect(c1.samples[179]?.status).toBe('ok');
    expect(c1.samples[181]?.status).toBe('ok');
    expect(c1.validCount).toBe(400);
  });

  test('marks the hidden channel at a collision and keeps the visible one', () => {
    const image = bitmap(421, 221);
    plot(image, yellow, () => 94);
    plot(image, magenta, col => col >= 135 && col <= 155 ? 94 : 125);
    const result = analyzeCapture(image, 'collision.png', overrides);
    const c1 = traceById(result.traces, 'C1');
    const c2 = traceById(result.traces, 'C2');
    expect(c1.samples[145]).toMatchObject({ status: 'overlap_ambiguous', yPx: null, voltage: null });
    expect(c1.overlapCount).toBe(21);
    expect(c2.samples[145]).toMatchObject({ status: 'ok', yPx: 94 });
  });

  test('honors manual scales and time origin', () => {
    const image = bitmap(421, 221);
    plot(image, yellow, () => 90);
    const result = analyzeCapture(image, 'manual.png', {
      ...overrides, secPerDiv: 0.002, triggerOffsetSec: 0.001,
      channels: { C1: { voltsPerDiv: 2, offsetVolts: 0.8 }, C2: { enabled: false } },
    });
    const c1 = traceById(result.traces, 'C1');
    expect(c1.settings).toMatchObject({ zeroY: 100, voltsPerDiv: 2, offsetVolts: 0.8, scaleSource: 'manual', zeroSource: 'manual' });
    expect(c1.samples[200]).toMatchObject({ timeSec: 0.001, voltage: 0.8 });
    expect(result.traces).toHaveLength(1);
  });
});

test('reports a signed phase for the first enabled channels when they are C1 and C3', () => {
  const image = bitmap(421, 221);
  plot(image, yellow, col => 72 - 25 * Math.cos(2 * Math.PI * col / 80));
  plot(image, [40, 230, 230], col => 151 - 30 * Math.cos(2 * Math.PI * col / 80 + Math.PI / 3));
  const result = analyzeCapture(image, 'phase13.png', overrides);
  expect(result.phaseC1ToC2).toBeNull();
  expect(result.phasePair).toMatchObject({ from: 'C1', to: 'C3', phaseDeg: expect.closeTo(60, 0) });
});

test('keeps native yellow and magenta on the white Siglent print background', () => {
  const image = decodePng(sample('sine_schmitt.png'));
  const { grid } = detectProfile(image);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    const r = image.data[i]!, g = image.data[i + 1]!, b = image.data[i + 2]!;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > 30 && y >= 540) {
      pixel(image, x, y, [Math.round(0.7 * r), Math.round(0.7 * g), Math.round(0.7 * b)]);
    } else if (chroma > 30 && y >= grid.top && y <= grid.bottom) {
      pixel(image, x, y, [255, 255, 255]);
    } else {
      pixel(image, x, y, [255 - r, 255 - g, 255 - b]);
    }
  }
  const a = (col: number) => 135 + Math.round(20 * Math.sin(col / 40));
  const b = (col: number) => 350 + Math.round(20 * Math.cos(col / 40));
  for (let col = 0; col <= grid.width; col++) {
    const x = grid.left + col;
    pixel(image, x, a(col) - 1, [120, 120, 0]);
    pixel(image, x, a(col) + 1, [120, 120, 0]);
    pixel(image, x, b(col) - 1, [120, 0, 60]);
    pixel(image, x, b(col) + 1, [120, 0, 60]);
    if (col !== 200) {
      pixel(image, x, a(col), yellow);
      pixel(image, x, b(col), magenta);
    }
    if (col % 10 < 3) pixel(image, x, 240, [179, 179, 0]);
  }
  const result = analyzeCapture(image, 'print-mode.png');
  expect(result.detection).toMatchObject({ profileId: 'siglent-sds2000x-plus', grid: { inverted: true } });
  expect(result.traces.map(t => t.channel)).toEqual(['C1', 'C2']);
  expect(result.traces.map(t => t.settings.scaleSource)).toEqual(['ocr', 'ocr']);
  expect(result.maskCoveragePct).toBeGreaterThan(0);
  for (const [index, fn] of [a, b].entries()) {
    const trace = result.traces[index]!;
    expect(trace.validCount).toBe(grid.width + 1);
    for (const col of [0, 200, 400, 800]) expect(trace.samples[col]?.yPx).toBeCloseTo(fn(col), 8);
  }
});

test('reads Schmitt scope measurements and compares them in base units', () => {
  const result = analyzePngBytes(sample('sine_schmitt.png'), 'sine_schmitt.png');
  expect(result.topFrequencyHz).toBeCloseTo(999.9877, 5);
  expect(result.timebase).toMatchObject({ secPerDiv: 0.0005, source: 'ocr' });
  expect(result.scopeReadings).toEqual([
    { label: 'Amplitude', metric: 'amplitude', channel: 'C2', value: 20.33, unit: 'V', rawText: '20.33V' },
    { label: 'Freq', metric: 'freq', channel: 'C2', value: 1000.005, unit: 'kHz', rawText: '1.0000050kHz' },
  ]);
  expect(result.comparisons).toContainEqual(expect.objectContaining({ channel: 'C2', metric: 'freq', unit: 'Hz', scopeValue: 1000.005 }));
  expect(result.measurements[0]!.frequencyHz).toBeCloseTo(1000, 0);
  expect(result.measurements[1]!.dutyCyclePct).toBeCloseTo(50, 0);
});

test.each(['sine_schmitt.png', 'sweep_04.png'])('keeps scope readings in inverse print polarity for %s', fileName => {
  const image = decodePng(sample(fileName));
  const dark = detectProfile(image);
  const expected = readScopeMetadata(image, dark);
  const darkTraces = analyzeCapture(image, fileName).traces;
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 255 - image.data[i]!;
    image.data[i + 1] = 255 - image.data[i + 1]!;
    image.data[i + 2] = 255 - image.data[i + 2]!;
  }
  const print = detectProfile(image);
  expect(print).toMatchObject({ profileId: dark.profileId, grid: { layoutVariant: dark.grid.layoutVariant, inverted: true } });
  const inverted = readScopeMetadata(image, print);
  expect(inverted.scopeReadings).toEqual(expected.scopeReadings);
  expect(inverted.topFrequencyRaw).toEqual(expected.topFrequencyRaw);
  expect(inverted.rawTimebase).toBe(expected.rawTimebase);
  const invertedTraces = analyzeCapture(image, fileName).traces;
  expect(invertedTraces.map(trace => trace.channel)).toEqual(darkTraces.map(trace => trace.channel));
  for (const trace of invertedTraces) {
    const expected = traceById(darkTraces, trace.channel);
    expect(trace.settings.voltsPerDiv).toBe(expected.settings.voltsPerDiv);
    expect(trace.validCount).toBeGreaterThan(expected.validCount * 0.98);
    expect(trace.samples[50]?.voltage).toEqual(expected.samples[50]?.voltage);
  }
});
