import { describe, expect, test } from 'vitest';
import { compareWithScopeCsv, parseScopeCsv } from '../../src/core/compare.js';
import { renderWaveformCsv } from '../../src/core/export/csv.js';
import { renderWaveformSvg } from '../../src/core/export/svg.js';
import { renderMeasurementsTable } from '../../src/core/export/table.js';
import { computeMathTrace } from '../../src/core/math.js';
import { measureChannel } from '../../src/core/measurements.js';
import { analyzePngBytes } from '../../src/core/pipeline.js';
import { makeGrid } from '../../src/core/profiles.js';
import { computeSpectrum, renderSpectrumCsv, renderSpectrumSvg, renderSpectrumTable } from '../../src/core/spectrum.js';
import { decodeUart } from '../../src/core/uart.js';
import { computeXyPlot, renderXyCsv, renderXySvg } from '../../src/core/xy.js';
import type { ChannelId, ChannelTrace, ExtractionResult, GapStatus } from '../../src/core/types.js';
import { sample } from './fixtures.js';

interface Series {
  readonly wave: (col: number) => number;
  readonly faults?: Readonly<Record<number, GapStatus>>;
  readonly scale?: number;
  readonly id?: ChannelId;
}

function capture(count: number, dt: number, ...series: readonly Series[]): ExtractionResult {
  const grid = makeGrid(0, 0, count - 1, 480, 10, 8, 'manual', false);
  const traces = series.map(({ wave, faults, scale = 1, id }, i): ChannelTrace => {
    const channel = id ?? (i === 0 ? 'C1' : 'C2');
    const samples = Array.from({ length: count }, (_, col) => {
      const status = faults?.[col] ?? 'ok';
      const voltage = status === 'ok' ? wave(col) : null;
      return {
        col, xPx: col, timeSec: (col - grid.centerX) * dt,
        yPx: voltage === null ? null : grid.centerY - 60 * voltage / scale, voltage, status,
      };
    });
    return {
      channel, settings: {
        channel, enabled: true, voltsPerDiv: scale, offsetVolts: 0, zeroY: 240, probeAttenuation: 1,
        coupling: 'DC', scaleSource: 'manual', zeroSource: 'manual', rawScaleText: null, rawOffsetText: null,
      },
      samples, validCount: samples.filter(s => s.status === 'ok').length,
      clippedCount: samples.filter(s => s.status === 'clipped_high' || s.status === 'clipped_low').length,
      maskedCount: samples.filter(s => s.status === 'masked_cursor' || s.status === 'masked_overlay').length,
      overlapCount: 0, unresolvedCount: 0, medianThicknessPx: 1,
    };
  });
  return {
    fileName: 'synthetic.png', imageWidth: count, imageHeight: 481,
    detection: {
      profileId: 'universal-fallback', profileName: 'Synthetic', confidence: 1, fallbackReason: null,
      matchedAnchors: [], grid, digitalOnly: false, warnings: [],
    },
    timebase: { secPerDiv: dt * grid.pxPerHDiv, triggerOffsetSec: 0, source: 'manual', rawText: null },
    topFrequencyHz: null, topFrequencyRaw: null, traces, measurements: traces.map(t => measureChannel(t, grid.pxPerVDiv)),
    phaseC1ToC2: null, scopeReadings: [], comparisons: [], maskCoveragePct: 0, elapsedMs: 0,
  };
}

const sine = (col: number, period = 80) => Math.sin(2 * Math.PI * col / period);

describe('math trace', () => {
  test('uses both columns, retains fault priority, and leaves overflow or missing values unresolved', () => {
    const a = { wave: (i: number) => i === 7 ? Infinity : 1.5, faults: {
      1: 'overlap_ambiguous', 2: 'masked_cursor', 3: 'masked_overlay', 4: 'unresolved', 5: 'clipped_high',
    } } as const;
    const b = { wave: () => 2, faults: {
      1: 'clipped_low', 2: 'overlap_ambiguous', 3: 'masked_cursor', 4: 'masked_overlay', 5: 'clipped_low',
    } } as const;
    const source = capture(9, 1e-5, a, b);
    const [first, second] = source.traces;
    const result = { ...source, traces: [{ ...first!, samples: [...first!.samples].reverse().filter(s => s.col !== 8) }, second!] };
    const math = computeMathTrace(result, { op: 'sub', a: 'C1', b: 'C2' })!;
    expect(math.samples.map(s => s.status)).toEqual([
      'ok', 'clipped_low', 'overlap_ambiguous', 'masked_cursor', 'masked_overlay', 'clipped_high', 'ok', 'unresolved', 'unresolved',
    ]);
    expect(math.samples.map(s => s.voltage)).toEqual([-0.5, null, null, null, null, null, -0.5, null, null]);
    expect(math).toMatchObject({ offsetVolts: -0.5, validCount: 2, gapCount: 7, label: 'M', unit: 'V' });
    expect(computeMathTrace(result, { op: 'sub', a: 'C1', b: 'C3' })).toBeNull();
  });

  test('warns about cancellation and incompatible additive scales and withholds timing measurements', () => {
    const result = capture(501, 1e-5, { wave: sine }, { wave: i => 0.99 * sine(i) + 0.025 * sine(i, 40), scale: 10 });
    const math = computeMathTrace(result, { op: 'sub', a: 'C1', b: 'C2' })!;
    expect(math.warnings).toEqual(['mismatched_math_scale', 'math_low_swing']);
    expect(math.measurement).toMatchObject({ frequencyHz: null, riseTimeSec: null, fallTimeSec: null });
    const addition = computeMathTrace(result, { op: 'add', a: 'C1', b: 'C2' })!;
    expect(addition.voltsPerDiv).toBe(1);
    expect(addition.measurement.frequencyHz).toBeCloseTo(1250, 0);
  });

  test('exports a scaled, labeled product with its unit and strict gaps in SVG, CSV and tables', () => {
    const result = capture(121, 1e-5, { wave: sine, faults: { 31: 'masked_cursor' } }, { wave: i => 2 * sine(i) });
    const math = computeMathTrace(result, { op: 'mul', a: 'C1', b: 'C2', label: 'P <1>', voltsPerDiv: 0.5, offsetVolts: 1 })!;
    expect(math).toMatchObject({ unit: 'V²', voltsPerDiv: 0.5, offsetVolts: 1 });
    expect(math.samples[20]?.voltage).toBeCloseTo(2);
    expect(math.warnings).toEqual([]);
    const csv = renderWaveformCsv(result, undefined, 'Product', math);
    expect(csv).toContain('# M: P <1> C1 mul C2 unit=V²');
    expect(csv).toContain('m_v2,m_status');
    expect(csv.split('\n').filter(line => !line.startsWith('#'))[32]).toMatch(/,,masked_cursor$/);
    const svg = renderWaveformSvg(result, { math });
    expect(svg).toContain('stroke-dasharray="3 2"');
    expect(svg).toContain('P &lt;1&gt; (V²)');
    expect(renderMeasurementsTable(result, 'tsv', 'en', undefined, undefined, math)).toContain('P <1> (V²)');
  });

  test('autoscales a finite product even when the estimated pixel voltage overflows', () => {
    const result = capture(5, 0.001, { wave: i => (i - 2) * 5e153, scale: 1e156 },
      { wave: () => 1e154, scale: 1e156 });
    const math = computeMathTrace(result, { a: 'C1', b: 'C2', op: 'mul' })!;
    expect(Number.isFinite(math.voltsPerDiv)).toBe(true);
    expect(math.samples[0]!.voltage).toBeCloseTo(-1e308);
    expect(math.samples.at(-1)!.voltage).toBeCloseTo(1e308);
    const rows = math.samples.map(sample => sample.yPx);
    expect(rows.every(row => Number.isFinite(row) && row! >= 0 && row! <= 480)).toBe(true);
    expect(new Set(rows).size).toBe(5);
  });
});

describe('XY analysis', () => {
  test('pairs faults independently and never connects points across invalid columns', () => {
    const result = capture(8, 0.1, { wave: i => i, faults: { 2: 'clipped_high', 4: 'masked_overlay', 6: 'unresolved' } },
      { wave: i => 9 + i, faults: { 4: 'masked_cursor', 6: 'clipped_low' } });
    const xy = computeXyPlot(result, 'C1', 'C2');
    expect(xy.segments.map(s => s.map(p => p.col))).toEqual([[0, 1], [3], [5], [7]]);
    expect(xy).toMatchObject({ validCount: 5, gapCount: 3, clippedX: true, clippedY: true, xVpp: 7, yVpp: 7 });
    expect(xy.points[2]).toMatchObject({ x: null, y: 11, xStatus: 'clipped_high', yStatus: 'ok' });
    expect(renderXyCsv(xy)).toContain('2,-0.15,,11,clipped_high,ok');
    const svg = renderXySvg(xy, { title: 'XY test & label', theme: 'dark' });
    expect(svg.match(/<polyline\b/g)).toHaveLength(1);
    expect(svg.match(/<circle\b/g)).toHaveLength(3);
    expect(svg).toContain('Clipped rail');
    expect(svg).toContain('XY test &amp; label');
  });

  test('estimates phase for periodic sines and a single closed loop', () => {
    const dt = 1e-5;
    const a = { wave: (i: number) => 2 * sine(i, 100) + 0.4 };
    const b = { wave: (i: number) => 3 * sine(i - 12.5, 100) - 1 };
    const periodic = capture(501, dt, a, b);
    expect(computeXyPlot(periodic, 'C1', 'C2').lissajousPhaseDeg).toBeCloseTo(-45, 4);
    const closed = { ...capture(101, dt, a, b), measurements: [] };
    expect(computeXyPlot(closed, 'C1', 'C2').lissajousPhaseDeg).toBeCloseTo(-45, 4);
    const open = { ...capture(65, dt, a, b), measurements: [] };
    expect(computeXyPlot(open, 'C1', 'C2').lissajousPhaseDeg).toBeNull();
  });

  test('reports the thresholds on the bundled Schmitt loop', () => {
    const result = analyzePngBytes(sample('sine_schmitt.png'), 'sine_schmitt.png');
    const xy = computeXyPlot(result, 'C1', 'C2');
    expect(xy.lissajousPhaseDeg).toBeNull();
    expect(xy.hysteresis).toMatchObject({
      lowThresholdV: expect.closeTo(-6.6, 0), highThresholdV: expect.closeTo(6.7, 0), widthV: expect.closeTo(13.3, 0),
    });
  });

  test('does not report hysteresis from sampling the same threshold on different columns', () => {
    const wave = (i: number) => sine(i + 0.18, 13);
    const xy = computeXyPlot(capture(132, 0.001, { wave }, { wave: i => Number(wave(i) > 0.021) }), 'C1', 'C2');
    expect(xy.hysteresis).toBeNull();
  });

  test('uses M for either axis and serializes its actual units', () => {
    const result = capture(101, 0.001, { wave: sine }, { wave: () => 2, faults: { 20: 'overlap_ambiguous' } });
    const math = computeMathTrace(result, { a: 'C1', b: 'C2', op: 'mul' })!;
    const xy = computeXyPlot(result, 'M', 'C1', math);
    expect(xy).toMatchObject({ xUnit: 'V²', yUnit: 'V', validCount: 100 });
    expect(xy.points[20]).toMatchObject({ xStatus: 'overlap_ambiguous', yStatus: 'ok' });
    expect(renderXyCsv(xy)).toContain('x_v2,y_v,');
    expect(renderXySvg(xy, { xLabel: 'Power' })).toContain('Power (V²)');
  });

  test('plots distinct finite coordinates and labels when padding would overflow', () => {
    const result = capture(5, 0.001, { wave: i => (i - 2) * 8.5e153 }, { wave: () => 1e154 });
    const math = computeMathTrace(result, { a: 'C1', b: 'C2', op: 'mul' })!;
    const xy = computeXyPlot(result, 'M', 'M', math);
    const svg = renderXySvg(xy, { title: 'Plot &\x00\x0B\x1F\uFFFE', xLabel: 'Power\x0C\uFFFF' });
    expect(svg).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|Infinity|NaN/);
    expect(svg).toContain('Plot &amp;');
    expect(svg).toContain('Power (V²)');
    const coordinates = /<polyline points="([^"]+)"/.exec(svg)![1]!.split(' ');
    expect(new Set(coordinates).size).toBe(5);
    expect(svg).toContain('e+308 V²');
  });
});

describe('spectrum and harmonic THD', () => {
  test('corrects flat-top window image leakage at the first coherent bin', () => {
    const result = capture(512, 1 / 20_000, { wave: i => Math.SQRT2 * Math.cos(2 * Math.PI * i / 512) });
    const spec = computeSpectrum(result, { channel: 'C1', window: 'flattop' });
    expect(spec.bins[2]!.vrms).toBeCloseTo(1, 9);
    expect(spec.fundamental).toBeNull();
    const svg = renderSpectrumSvg(spec, { title: 'FFT <tone>\x01\x0E\uFFFF' });
    expect(svg).toContain('FFT &lt;tone&gt;');
    expect(svg).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/);
  });

  test.each(['rect', 'hann', 'blackman', 'flattop'] as const)('scales %s FFT bins in RMS and takes out the DC mean', window => {
    const dt = 1 / 20_000;
    const result = capture(512, dt, { wave: i => 3 + 2 * sine(i, 32) });
    const spec = computeSpectrum(result, { channel: 'C1', window });
    const bin = spec.bins.find(b => b.frequencyHz === 625)!;
    expect(bin.vrms).toBeCloseTo(Math.SQRT2, 7);
    expect(bin.dbv).toBeCloseTo(3.0102999566, 7);
    expect(spec.bins[0]!.vrms).toBeLessThan(1e-10);
    expect(spec.resolutionBandwidthHz).toBeCloseTo(1 / (512 * dt), 9);
    expect(spec.binSpacingHz).toBeCloseTo(spec.resolutionBandwidthHz! / 2, 9);
    expect(spec.fundamental?.frequencyHz).toBeCloseTo(625, 2);
    expect(spec.noiseFloorDbv).toBeCloseTo(spec.fundamental!.dbv! - 50, 10);
    expect(spec.thdPct).toBeLessThan(1e-3);
    expect(spec.thdBelowFloor).toBe(true);
  });

  test('uses the special RMS normalization for the real Nyquist bin', () => {
    const result = capture(128, 0.0001, { wave: i => i % 2 ? -2 : 2 });
    const spec = computeSpectrum(result, { channel: 'C1', window: 'rect' });
    expect(spec.bins.at(-1)).toMatchObject({ frequencyHz: expect.closeTo(5000, 7), vrms: expect.closeTo(2, 7) });
    expect(spec.thdReason).toBe('insufficient_resolution');
  });

  test.each([['rect', 5.05], ['flattop', 3.3]] as const)('finds a short %s-window tone without mistaking sidelobes for subharmonics', (window, cycles) => {
    const dt = 1 / 20_000, count = 512, f0 = cycles / (count * dt);
    const result = capture(count, dt, { wave: i => 1.4 * sine(i + 0.1, count / cycles) });
    const spec = computeSpectrum(result, { window, channel: 'C1' });
    expect(spec.fundamental?.frequencyHz).toBeCloseTo(f0, 2);
    expect(spec.thdBelowFloor).toBe(true);
  });

  test('keeps a measured fundamental when its second harmonic is stronger', () => {
    const dt = 1 / 40_000, f0 = 912;
    const result = capture(501, dt, { wave: i => 0.5 * sine(i, 1 / (dt * f0)) + 1.5 * sine(i, 1 / (dt * 2 * f0)) });
    const spec = computeSpectrum(result, { channel: 'C1' });
    expect(spec.fundamental?.frequencyHz).toBeCloseTo(f0, 1);
    expect(spec.thdPct).toBeCloseTo(300, 2);
  });

  test('fits off-bin harmonics jointly on observed columns and bridges only short cursor gaps', () => {
    const dt = 1 / 40_000, f0 = 927.37;
    const wave = (i: number) => {
      const phase = 2 * Math.PI * i * dt * f0;
      return 1.6 + 1.4 * Math.sin(phase + 0.3) + 0.07 * Math.cos(2 * phase) + 0.028 * Math.sin(3 * phase - 0.2);
    };
    const faults = { 109: 'masked_cursor', 320: 'masked_cursor', 321: 'masked_cursor', 400: 'masked_overlay' } as const;
    const result = capture(550, dt, { wave, faults });
    const spec = computeSpectrum(result, { channel: 'C1' });
    expect(spec.usedStartSec).toBe(result.traces[0]!.samples[0]!.timeSec);
    expect(spec.usedEndSec).toBe(result.traces[0]!.samples[399]!.timeSec);
    expect(spec.coverage).toBeCloseTo(397 / 550);
    expect(spec).toMatchObject({ interpolatedGaps: 2, interpolatedColumns: 3, thdBelowFloor: false, thdReason: null });
    expect(spec.fundamental?.frequencyHz).toBeCloseTo(f0, 1);
    expect(spec.thdPct).toBeCloseTo(100 * Math.hypot(0.05, 0.02), 3);
    expect(spec.harmonics.map(h => h.order)).toEqual([1, 2, 3, 4, 5]);
    expect(renderSpectrumCsv(spec)).toContain('frequency_hz,vrms,dbv');
    expect(renderSpectrumSvg(spec, { scale: 'linear' })).toContain('H5');
    expect(renderSpectrumSvg(spec)).toContain('stroke-dasharray="4 3"');
    for (const format of ['tsv', 'markdown', 'html', 'latex'] as const) {
      expect(renderSpectrumTable(spec, 'fr', format, 'Distorsion')).toContain('5,39%'.replace('%', format === 'latex' ? '\\%' : '%'));
    }
  });

  test('splits at hard gaps and enforces the 5% bridge budget', () => {
    const faults: Record<number, GapStatus> = { 89: 'masked_cursor', 90: 'masked_cursor', 91: 'masked_cursor', 92: 'masked_cursor' };
    for (let i = 5; i < 60; i += 7) faults[i] = 'masked_cursor';
    const result = capture(141, 0.001, { wave: sine, faults });
    const spec = computeSpectrum(result, { channel: 'C1' });
    expect(spec.usedStartSec).toBe(result.traces[0]!.samples[93]!.timeSec);
    expect(spec.interpolatedGaps).toBe(0);
  });

  test.each([
    [250, 149, 100, 'insufficient_cycles'],
    [250, 197, 100, 'insufficient_cycles'],
    [1001, 93, 24, 'insufficient_samples'],
  ] as const)('withholds an unreliable fundamental in a %i-column capture', (count, length, period, thdReason) => {
    const faults = Object.fromEntries(Array.from({ length: count - length }, (_, i) => [i + length, 'overlap_ambiguous' as const]));
    const result = capture(count, 0.0001, { wave: i => 2 + sine(i + 4, period), faults });
    const spec = computeSpectrum(result, { channel: 'C1' });
    expect(spec).toMatchObject({ fundamental: null, thdPct: null, thdReason });
    expect(spec.coverage).toBeCloseTo(length / count);
    expect(Math.max(...spec.bins.map(bin => bin.vrms))).toBeLessThan(2);
  });

  test('measures THD within a hundredth of three cycles', () => {
    const count = 500, cycles = 2.9996;
    const result = capture(count, 1e-5, { wave: i => sine(i, count / cycles) + 0.05 * sine(i, count / (cycles * 2)) });
    const spec = computeSpectrum(result, { channel: 'C1' });
    expect(spec.fundamental!.frequencyHz * spec.durationSec).toBeCloseTo(cycles, 4);
    expect(spec.thdReason).toBeNull();
    expect(spec.thdPct).toBeCloseTo(5, 3);
  });

  test('includes the seventh harmonic in THD while preserving the reported harmonics', () => {
    const dt = 1 / 40_000, period = 50.8;
    const result = capture(512, dt, { wave: i => 1.8 * sine(i, period) + 0.18 * sine(i + 0.37, period / 7) });
    const spec = computeSpectrum(result, { channel: 'C1' });
    expect(spec.fundamental!.frequencyHz).toBeCloseTo(1 / (dt * period), 2);
    expect(spec.thdReason).toBeNull();
    expect(spec.thdPct).toBeCloseTo(10, 3);
    expect(spec.harmonics.map(h => h.order)).toEqual([1, 2, 3, 4, 5]);
  });

  test('rejects an overflowing reciprocal sample interval', () => {
    const spec = computeSpectrum(capture(80, 1e-309, { wave: sine }), { channel: 'C1' });
    expect(spec).toMatchObject({ sampleRateHz: 0, bins: [], fundamental: null, thdReason: 'insufficient_samples' });
    expect(spec.warnings).toContain('invalid_sample_rate');
  });

  test.each([
    [450, 90, 1, { 449: 'clipped_high' }, 'clipped'],
    [240, 100, 1, {}, 'insufficient_cycles'],
    [420, 14, 1, {}, 'insufficient_resolution'],
    [500, 45, 0.2, {}, 'insufficient_swing'],
  ] as const)('refuses unjustified THD in a %i-column capture', (count, period, amplitude, faults, reason) => {
    const spec = computeSpectrum(capture(count, 0.0001, { wave: i => amplitude * sine(i, period), faults }), { channel: 'C1' });
    expect(spec).toMatchObject({ thdPct: null, thdBelowFloor: false, harmonics: [], thdReason: reason });
    expect(spec.bins.length).toBeGreaterThan(0);
  });
});

function uartCapture(bytes: readonly number[], px: number, baud: number,
  options: { idleHigh?: boolean; idleBits?: number; parity?: boolean; badParity?: boolean; badStop?: boolean; faults?: Record<number, GapStatus> } = {}) {
  const bits: number[] = Array<number>(options.idleBits ?? 3).fill(1);
  for (const byte of bytes) {
    const data = Array.from({ length: options.parity ? 7 : 8 }, (_, i) => byte >> i & 1);
    const parity = data.reduce((a, b) => a ^ b, 0) ^ Number(Boolean(options.badParity));
    bits.push(0, ...data, ...(options.parity ? [parity, Number(!options.badStop), 1] : [Number(!options.badStop)]));
  }
  bits.push(1, 1, 1);
  return capture(bits.length * px, 1 / (px * baud), {
    wave: i => (bits[Math.floor(i / px)] === Number(options.idleHigh ?? true)) ? 4.8 : 0.2,
    faults: options.faults,
  });
}

describe('analog UART', () => {
  test('snaps to the standard rate that fits consecutive frame edges and reports bytes in time order', () => {
    const result = uartCapture([65, 0, 85, 33], 19, 38400);
    const uart = decodeUart(result, { channel: 'C1' });
    expect(uart).toMatchObject({ baud: 38400, pxPerBit: 19, text: 'A\0U!', reason: null });
    expect(uart.frames.map(f => [f.hex, f.ascii])).toEqual([['41', 'A'], ['00', '.'], ['55', 'U'], ['21', '!']]);
    expect(uart.frames[0]!.endSec - uart.frames[0]!.startSec).toBeCloseTo(10 / 38400, 12);
    expect(uart.frames.every(frame => !frame.uncertain && !frame.framingError && !frame.parityError)).toBe(true);
  });

  test('decodes inverted 7E2 and reports parity errors, bad stops and uncertain masked data', () => {
    const result = uartCapture([0x59], 12, 19200, {
      idleHigh: false, parity: true, badParity: true, badStop: true, faults: { 54: 'masked_cursor' },
    });
    const uart = decodeUart(result, { channel: 'C1', baud: 19200, idleHigh: false, dataBits: 7, parity: 'even', stopBits: 2, thresholdVolts: 2 });
    expect(uart.frames).toMatchObject([{ byte: 0x59, parityError: true, framingError: true, uncertain: true }]);
    expect(uart.warnings).toEqual(expect.arrayContaining(['framing_errors', 'parity_errors']));
    expect(uart.text).toBe('\uFFFD');
  });

  test('rejects a sine wave in automatic baud mode', () => {
    const result = capture(601, 1 / (12 * 9600), { wave: i => 2.5 + 2.5 * sine(i, 12) });
    expect(decodeUart(result, { channel: 'C1' })).toMatchObject({ reason: 'baud_unresolved', frames: [] });
  });

  test('finds the lone low start bit after 400 high idle bits', () => {
    const result = uartCapture([0xff], 12, 9600, { idleBits: 400 });
    for (const thresholdVolts of [undefined, 2.3]) {
      const uart = decodeUart(result, { channel: 'C1', thresholdVolts });
      expect(uart).toMatchObject({ baud: 9600, reason: null, frames: [{ hex: 'FF', framingError: false, uncertain: false }] });
    }
  });

  test.each([['masked_cursor', 0], ['masked_overlay', 1]] as const)('resynchronizes after a %s start edge', (status, skip) => {
    const px = 12, damagedStart = (3 + skip * 10) * px;
    const faults = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [damagedStart - 2 + i, status]));
    const result = uartCapture([...Array<number>(skip).fill(0xa5), 0x18, 0x5a, 0x55], px, 9600, { faults });
    for (const baud of [9600, 'auto'] as const) {
      const uart = decodeUart(result, { channel: 'C1', baud });
      expect(uart.frames.slice(-2)).toMatchObject([
        { hex: '5A', uncertain: false, framingError: false }, { hex: '55', uncertain: false, framingError: false },
      ]);
    }
  });

  test('resynchronizes when the mask removes a whole midstream start pulse', () => {
    const px = 12, damagedStart = 13 * px;
    const faults = Object.fromEntries(Array.from({ length: px }, (_, i) => [damagedStart + i, 'masked_overlay' as const]));
    const result = uartCapture([0xa5, 0x01, 0x5a, 0x55], px, 9600, { faults });
    for (const baud of [9600, 'auto'] as const) {
      const uart = decodeUart(result, { channel: 'C1', baud });
      expect(uart.frames).toMatchObject([
        { hex: 'A5', framingError: false },
        { hex: '5A', uncertain: false, framingError: false },
        { hex: '55', uncertain: false, framingError: false },
      ]);
    }
  });

  test('rejects below six pixels per bit and warns below eight', () => {
    const tooSmall = uartCapture([65, 90, 85], 5, 115200);
    expect(decodeUart(tooSmall, { channel: 'C1', baud: 115200 })).toMatchObject({ reason: 'insufficient_resolution', frames: [] });
    expect(decodeUart(tooSmall, { channel: 'C1' })).toMatchObject({ baud: 115200, reason: 'insufficient_resolution' });
    const marginal = uartCapture([65, 90, 85], 7, 115200);
    expect(decodeUart(marginal, { channel: 'C1', baud: 115200 })).toMatchObject({ text: 'AZU', warnings: ['low_resolution'] });
  });
});

describe('scope CSV comparison', () => {
  test('parses Siglent recordings, Rigol index calibration and generic CSV with gaps', () => {
    expect(parseScopeCsv('Record Length,3\nSecond,Volt\n-0.001,1.8\n0,2.1\n0.001,2.4')).toMatchObject({
      format: 'siglent', columns: ['Volt'], rows: [{ timeSec: -0.001, values: [1.8] },
        { timeSec: 0, values: [2.1] }, { timeSec: 0.001, values: [2.4] }],
    });
    expect(parseScopeCsv('X,CH1,CH2\r\nStart,-0.002,-0.002\r\nIncrement,0.001,0.001\r\n0,1,2\r\n1,2,3')).toMatchObject({
      format: 'rigol', columns: ['CH1', 'CH2'], rows: [{ timeSec: -0.002, values: [1, 2] }, { timeSec: -0.001, values: [2, 3] }],
    });
    expect(parseScopeCsv('X,CH1,CH2,Start,Increment\nSequence,Volt,Volt,-0.002,0.001\n0,1,2\n1,2,3')).toMatchObject({
      format: 'rigol', columns: ['CH1', 'CH2'], rows: [{ timeSec: -0.002, values: [1, 2] }, { timeSec: -0.001, values: [2, 3] }],
    });
    expect(parseScopeCsv('\uFEFF"time_s";"volts A";"volts B"\n1;1;\n0;;4')).toMatchObject({
      format: 'generic', columns: ['volts A', 'volts B'], rows: [{ timeSec: 0, values: [null, 4] }, { timeSec: 1, values: [1, null] }],
    });
    expect(() => parseScopeCsv('second,volt\n0,')).toThrow(/no numeric voltage/);
  });

  test.each(['1"2"', '"12', '"12"3'])('rejects malformed CSV field %s', field => {
    expect(() => parseScopeCsv(`"Time","C1"\n0,1\n1,${field}`)).toThrow(/quoted field/);
    expect(parseScopeCsv('"Time";"Bench ""A"""\n0;"12"').columns).toEqual(['Bench "A"']);
  });

  test('requires an explicitly requested channel in named CSV columns unless overridden', () => {
    const result = capture(5, 1, { wave: i => i, id: 'C2' });
    const named = parseScopeCsv('Time,C1,C3\n-1,1,9\n0,2,9\n1,3,9');
    expect(() => compareWithScopeCsv(result, named, { channel: 'C2' })).toThrow(/CSV is missing channel C2/);
    expect(compareWithScopeCsv(result, named, { channel: 'C2', csvColumn: 'c1' }).csvColumn).toBe('C1');
    expect(compareWithScopeCsv(result, parseScopeCsv('Second,Volt\n0,2\n1,3'), { channel: 'C2' }).csvColumn).toBe('Volt');
  });

  test('reports unaligned and lag-aligned errors at usable timestamps, with a bounded search', () => {
    const dt = 5e-6, shift = 1.2, n = 801;
    const wave = (i: number) => 0.8 * sine(i, 81);
    const result = capture(n, dt, { wave, faults: { 200: 'masked_cursor', 201: 'masked_cursor', 500: 'clipped_low' } });
    const csv = parseScopeCsv('time_s,CH1,unused\n' + Array.from({ length: 4 * n }, (_, i) => {
      const col = i / 4;
      return `${(col - (n - 1) / 2) * dt},${wave(col - shift)},0`;
    }).join('\n'));
    const comparison = compareWithScopeCsv(result, csv);
    expect(comparison).toMatchObject({ channel: 'C1', csvColumn: 'CH1', usableCount: n - 3 });
    expect(comparison.unaligned).toMatchObject({
      lagPx: 0, coverage: 1, rmsePx: expect.closeTo(3.16, 0), quantizationFloorPx: 1 / Math.sqrt(12),
    });
    expect(comparison.aligned.lagPx).toBe(1.2);
    expect(comparison.aligned.coverage).toBeLessThan(1);
    expect(comparison.aligned.rmseV).toBeLessThan(0.0001);
    expect(comparison.aligned.vppDeltaV).toBeCloseTo(0, 3);
    expect(comparison.aligned.frequencyDeltaPct).toBeCloseTo(0, 3);
    expect(compareWithScopeCsv(result, csv, { maxLagPx: 0.5 }).aligned.lagPx).toBe(0.5);
  });

  test('preserves limited overlap and leaves absent reference data blank', () => {
    const result = capture(5, 1, { wave: i => i + 2 });
    const csv = parseScopeCsv('X,CH1,CH2\n-1,9,3\n0,9,\n1,9,5\n');
    const comparison = compareWithScopeCsv(result, csv, { csvColumn: 'ch2' });
    expect(comparison.unaligned).toMatchObject({ matchedCount: 2, coverage: 0.4, rmseV: 0, maeV: 0, maxErrorV: 0 });
    expect(compareWithScopeCsv(result, parseScopeCsv('time_s,volts\n10,5\n20,6')).aligned)
      .toMatchObject({ coverage: 0, matchedCount: 0, rmseV: null, frequencyDeltaPct: null });
  });

  test('finds a 1.2-pixel lag with only two matching columns', () => {
    const result = capture(9, 1, { wave: i => i - 4 });
    const csv = parseScopeCsv('Time,C1\n0.2,-1\n1.2,0\n1.3,0.1');
    expect(compareWithScopeCsv(result, csv).aligned).toMatchObject({ lagPx: 1.2, rmseV: 0, matchedCount: 2 });
  });

  test('leaves flat reference values exact and keeps zero lag on equal error', () => {
    const result = capture(9, 1, { wave: () => 0.1 });
    const csv = parseScopeCsv('Time,C1\n-4,0.1\n4,0.1');
    const comparison = compareWithScopeCsv(result, csv);
    expect(comparison.aligned).toBe(comparison.unaligned);
    expect(comparison.aligned).toMatchObject({ lagPx: 0, rmseV: 0, vppDeltaV: 0, vppDeltaPct: null });
  });
});
