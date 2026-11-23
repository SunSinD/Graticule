import { describe, expect, test } from 'vitest';
import { compareWithScopeCsv, parseScopeCsv } from '../../src/core/compare.js';
import { glyphs as siglentGlyphs, labels as siglentLabels } from '../../src/core/font/siglentFont.js';
import { compareScope } from '../../src/core/measurements.js';
import { analyzeCapture, analyzePngBytes } from '../../src/core/pipeline.js';
import { readScopeMetadata } from '../../src/core/ocr.js';
import { decodePng } from '../../src/core/png.js';
import { detectProfile } from '../../src/core/profiles.js';
import type { ChannelId, ChannelTrace, ExtractionOverrides, RgbaImage } from '../../src/core/types.js';
import { decodeUart } from '../../src/core/uart.js';
import { bitmap, magenta, paint, pixel, sample, yellow } from './fixtures.js';
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

  test('keeps yellow square-wave plateaus that are connected by repeated vertical transitions', () => {
    const image = bitmap(201, 81);
    for (let x = 0; x < image.width; x++) {
      const phase = x % 20;
      const y = phase < 5 ? 20 : 60;
      paint(image, { x, y: phase === 0 || phase === 5 ? 20 : y, width: 1,
        height: phase === 0 || phase === 5 ? 41 : 1 }, [255, 255, 0]);
    }
    const result = analyzeCapture(image, 'square-wave.png', { manualCrop: { x: 0, y: 0, width: 200, height: 80 } });
    expect(result.traces).toMatchObject([{ channel: 'C1', validCount: 201, maskedCount: 0 }]);
    expect(result.measurements[0]?.dutyCyclePct).toBeCloseTo(25, 0);
  });

  test('reads negative Siglent duty and compares it to time spent low', () => {
    const image = decodePng(sample('sine_schmitt.png'));
    const detection = detectProfile(image);
    const label = Object.keys(siglentLabels).find(tokens => siglentLabels[tokens] === '+Duty')!.split(' ');
    const value = [...'75%'].map(char => Object.keys(siglentGlyphs).find(glyph => siglentGlyphs[glyph] === char)!);
    const draw = (glyphs: readonly string[], x: number, y: number, ink: Rgb) => {
      for (const glyph of glyphs) {
        const rows = glyph.split('/');
        rows.forEach((row, dy) => [...row].forEach((bit, dx) => {
          if (bit === '#') pixel(image, x + dx, y + dy, ink);
        }));
        x += rows[0]!.length + 1;
      }
    };
    paint(image, { x: 10, y: 511, width: 233, height: 17 }, [14, 14, 14]);
    draw(['#######', ...label.slice(1)], 10, 513, yellow);
    draw(value, 131, 513, [255, 255, 255]);
    const reading = readScopeMetadata(image, detection).scopeReadings[0]!;
    expect(reading).toMatchObject({ label: '-Duty', metric: '-duty', channel: 'C1', value: 75, unit: '%' });
    const result = analyzePngBytes(sample('sine_schmitt.png'), 'measure.png');
    const c1 = { ...result.measurements[0]!, dutyCyclePct: 25 };
    const readings = [reading, { ...reading, label: '+Duty', metric: 'duty' as const, value: 25 },
      { ...reading, label: '-Duty(C1)', metric: 'duty' as const }];
    expect(compareScope(readings, [c1], result.traces, null, null)).toMatchObject([
      { metric: '-Duty', graticuleValue: 75, delta: 0 },
      { metric: 'duty', graticuleValue: 25, delta: 0 },
      { metric: '-Duty', graticuleValue: 75, delta: 0 },
    ]);

    for (let y = 511; y < 528; y++) {
      for (let x = 10; x < 122; x++) image.data[4 * (image.width * y + x) + 3] = 64;
    }
    expect(readScopeMetadata(image, detection).scopeReadings.some(item => item.label === '-Duty')).toBe(false);
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

describe('UART capture boundaries and auto baud', () => {
  const px = 12, baud = 9600;
  function capture(wave: (col: number) => number, count: number, maskedThrough?: number) {
    const image = bitmap(count, 100);
    for (let x = 0; x < count; x++) pixel(image, x, wave(x) ? 25 : 75, yellow);
    const result = analyzeCapture(image, 'uart.png', {
      secPerDiv: (count - 1) / (10 * px * baud), profileId: 'universal-fallback',
      manualCrop: { x: 0, y: 0, width: count - 1, height: 99 },
    });
    if (maskedThrough === undefined) return result;
    const trace = result.traces[0]!;
    return { ...result, traces: [{ ...trace, samples: trace.samples.map(sample => sample.col >= 143 && sample.col <= maskedThrough
      ? { ...sample, status: 'masked_cursor' as const, voltage: null, yPx: null } : sample) }] };
  }

  function bytes(values: readonly number[], cropLeft = 0, end = (6 + 10 * values.length) * px, maskedThrough?: number) {
    const bits = [1, 1, 1, ...values.flatMap(byte =>
      [0, ...Array.from({ length: 8 }, (_, bit) => (byte >> bit) & 1), 1]), 1, 1, 1];
    return capture(col => bits[Math.floor((col + cropLeft) / px)]!, end - cropLeft, maskedThrough);
  }

  test('chooses 9600 baud for a single alternating 55 byte', () => {
    const uart = decodeUart(bytes([0x55]), { channel: 'C1' });
    expect(uart).toMatchObject({ baud: 9600, pxPerBit: 12, reason: null, text: 'U', warnings: [], frames: [
      { hex: '55', parityError: false, framingError: false, uncertain: false },
    ] });
  });

  test('chooses 9600 baud for consecutive 80 bytes followed by FF', () => {
    const uart = decodeUart(bytes([0x80, 0x80, 0x80, 0x80, 0xff]), { channel: 'C1' });
    expect(uart.baud).toBe(9600);
    expect(uart.frames.map(frame => frame.hex)).toEqual(['80', '80', '80', '80', 'FF']);
  });

  test('rejects a square wave with a half cycle of 5.25 bit periods', () => {
    const halfCycle = 5.25 * px;
    const result = capture(col => 1 - (Math.floor(col / halfCycle) % 2), 20 * halfCycle);
    expect(decodeUart(result, { channel: 'C1' })).toMatchObject({ reason: 'baud_unresolved', frames: [] });
  });

  test.each([9600, 'auto'] as const)('resynchronizes after an obscured stop at baud %s', rate => {
    for (const maskedThrough of [154, 155]) {
      const uart = decodeUart(bytes([0x5a, 0xa5, 0xff], 0, undefined, maskedThrough), { channel: 'C1', baud: rate });
      expect(uart.frames).toMatchObject([
        { hex: '5A', framingError: true, uncertain: true },
        { hex: 'A5', framingError: false, uncertain: false },
        { hex: 'FF', framingError: false, uncertain: false },
      ]);
    }
  });

  test.each([9600, 'auto'] as const)('resynchronizes after a frame cropped on the left at baud %s', rate => {
    const uart = decodeUart(bytes([0xa5, 0x5a, 0x55], 48), { channel: 'C1', baud: rate });
    expect(uart.frames).toMatchObject([
      { byte: null, framingError: true, uncertain: true },
      { hex: '5A', framingError: false, uncertain: false },
      { hex: '55', framingError: false, uncertain: false },
    ]);
  });

  test.each([9600, 'auto'] as const)('flags a right-cropped stop bit at baud %s even when its center is visible', rate => {
    const uart = decodeUart(bytes([0x5a], 0, 153), { channel: 'C1', baud: rate });
    expect(uart.frames).toMatchObject([{ hex: '5A', framingError: true, uncertain: true }]);
  });
});

describe('scope CSV regression cases', () => {
  test('requires a matching named channel by default and honors explicit column overrides', () => {
    const image = bitmap(421, 221);
    plot(image, yellow, () => 125);
    const c1 = analyzeCapture(image, 'c1.png', overrides);
    const csv = parseScopeCsv('Time (s),C2\n-1,0\n1,0');
    expect(() => compareWithScopeCsv(c1, csv)).toThrow(/CSV is missing channel C1/);
    expect(compareWithScopeCsv(c1, csv, { channel: 'C1', csvColumn: 'c2' })).toMatchObject({ channel: 'C1', csvColumn: 'C2' });
    plot(image, magenta, () => 150);
    const both = analyzeCapture(image, 'both.png', overrides);
    expect(compareWithScopeCsv(both, csv)).toMatchObject({ channel: 'C2', csvColumn: 'C2' });
    expect(compareWithScopeCsv(both, parseScopeCsv('x-axis,2,1\nsecond,Volt,Volt\n-1,0,1\n1,0,1')))
      .toMatchObject({ channel: 'C1', csvColumn: '1' });
  });

  test('reads Keysight channel headers, declared units, and complementary duplicate timestamps', () => {
    expect(parseScopeCsv('x-axis,1,2,3,4\nms,mV,uV,\u00b5V,kV\n1,,2,,4\n1,1,,3,\n2,5,6,7,8')).toMatchObject({
      columns: ['1', '2', '3', '4'],
      rows: [{ timeSec: 0.001, values: [0.001, 2e-6, 3e-6, 4000] }, { timeSec: 0.002, values: [0.005, 6e-6, 7e-6, 8000] }],
    });
  });

  test.each([['ms', 1e-3], ['us', 1e-6], ['\u00b5s', 1e-6], ['ns', 1e-9]])('scales Time (%s) and CH1 (mV)', (timeUnit, scale) => {
    expect(parseScopeCsv(`Time (${timeUnit}),CH1 (mV)\n1,2000`).rows).toEqual([{ timeSec: scale, values: [2] }]);
  });

  test('reads Tektronix samples beside metadata', () => {
    expect(parseScopeCsv('Record Length,2,,0,1\nSample Interval,0.001,,0.001,2').rows).toEqual([
      { timeSec: 0, values: [1] }, { timeSec: 0.001, values: [2] },
    ]);
  });

  test('does not shift a short flat reference to discard a mismatched boundary sample', () => {
    const image = bitmap(421, 221);
    plot(image, yellow, col => col === 200 ? 85 : zero);
    const result = analyzeCapture(image, 'step.png', overrides);
    const rows = traceById(result.traces, 'C1').samples.slice(200, 203);
    const csv = parseScopeCsv(['Time (s),C1', ...rows.map(row => `${row.timeSec},0`)].join('\n'));
    const comparison = compareWithScopeCsv(result, csv);
    expect(comparison.unaligned).toMatchObject({ matchedCount: 3, rmseV: expect.closeTo(1 / Math.sqrt(3), 10) });
    expect(comparison.aligned).toBe(comparison.unaligned);
  });
});

test('uses C2 frequency for phase when every C1 peak is obscured', () => {
  const image = bitmap(421, 221);
  plot(image, yellow, col => col % 80 < 4 || col % 80 > 76 ? null : 65 - 24 * Math.cos(2 * Math.PI * col / 80));
  plot(image, magenta, col => 150 - 30 * Math.cos(2 * Math.PI * col / 80 + Math.PI / 4));
  const result = analyzeCapture(image, 'peak-gaps.png', overrides);
  expect(result.measurements.map(m => m.frequencyHz)).toEqual([null, expect.closeTo(1000, 4)]);
  expect(result.phaseC1ToC2?.phaseDeg).toBeCloseTo(45, 0);
  expect(result.phasePair).toMatchObject({ from: 'C1', to: 'C2', phaseDeg: expect.closeTo(45, 0) });
});

test('withholds phase for confirmed 1000 Hz and 1020 Hz waveforms', () => {
  const image = bitmap(421, 221);
  plot(image, yellow, col => 65 - 24 * Math.cos(2 * Math.PI * col / 80));
  plot(image, magenta, col => 150 - 30 * Math.cos(2 * Math.PI * 1.02 * col / 80 + Math.PI / 4));
  const result = analyzeCapture(image, 'different-frequencies.png', overrides);
  expect(result.measurements[0]?.frequencyHz).toBeCloseTo(1000, 0);
  expect(result.measurements[1]?.frequencyHz).toBeGreaterThan(1010);
  expect(result.phaseC1ToC2).toBeNull();
  expect(result.phasePair).toBeUndefined();
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
  const { top, bottom, left, right } = grid;
  const deskewed = analyzeCapture(image, 'deskewed-print-mode.png', {
    manualQuad: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }],
  });
  expect(deskewed.detection.grid.inverted).toBe(true);
  expect(deskewed.traces.map(t => t.channel)).toEqual(['C1', 'C2']);
  for (const [index, fn] of [a, b].entries()) {
    for (const col of [200, 400, 800]) expect(deskewed.traces[index]?.samples[col]?.yPx).toBeCloseTo(fn(col) - top, 0);
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
