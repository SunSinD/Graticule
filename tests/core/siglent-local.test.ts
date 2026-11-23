import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { analyzeBodeBatch, analyzePngBytes } from '../../src/core/pipeline.js';
import { buildOverlayMask, OVERLAY } from '../../src/core/mask.js';
import { decodePng } from '../../src/core/png.js';
import { computeSpectrum } from '../../src/core/spectrum.js';
import { decodeUart } from '../../src/core/uart.js';
import { computeXyPlot } from '../../src/core/xy.js';
import type { ExtractionResult } from '../../src/core/types.js';

const localRoot = process.env.GRATICULE_SIGLENT_ROOT;

function collectCaptureFiles(rootDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'captures') {
          for (const file of readdirSync(full).sort()) {
            if (file.toLowerCase().endsWith('.png')) found.push(join(full, file));
          }
        } else {
          walk(full);
        }
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

const localFiles = localRoot && existsSync(localRoot) ? collectCaptureFiles(localRoot) : [];

describe.skipIf(localFiles.length === 0)('local Siglent SDS2000X Plus capture regression suite', () => {
  const results = new Map<string, ExtractionResult>();
  const sweepResults: ExtractionResult[] = [];

  beforeAll(() => {
    const warmup = localFiles[0]!;
    analyzePngBytes(readFileSync(warmup), basename(warmup));
    for (const filePath of localFiles) {
      const name = basename(filePath);
      const result = analyzePngBytes(readFileSync(filePath), name);
      results.set(name, result);
      if (/^\d{2}\s*-\s*[\d.]+\s*[kM]?Hz\.png$/i.test(name)) {
        sweepResults.push(result);
      }
    }
  }, 15_000);

  test('matches native profile, timebase OCR, active channels, and stays under 300 ms after warmup', () => {
    expect(results.size).toBeGreaterThanOrEqual(20);
    for (const result of results.values()) {
      expect(result.detection.profileId, result.fileName).toBe('siglent-sds2000x-plus');
      expect(result.detection.fallbackReason, result.fileName).toBeNull();
      expect(result.timebase.source, result.fileName).toBe('ocr');
      expect(result.topFrequencyRaw, result.fileName).toMatch(/^f\([CD]\d\)[<=][\d.]+(?:k|M)?Hz$/);
      expect(result.traces.length === 0, result.fileName).toBe(result.detection.digitalOnly);
      for (const trace of result.traces) {
        expect(trace.settings.scaleSource, `${result.fileName} ${trace.channel}`).toBe('ocr');
        expect(trace.settings.zeroSource, `${result.fileName} ${trace.channel}`).toBe('card-offset');
        for (const point of trace.samples) {
          if (point.status !== 'ok') expect(point.voltage).toBeNull();
        }
      }
      const file = localFiles.find(path => basename(path) === result.fileName)!;
      const elapsedMs = result.elapsedMs < 300 ? result.elapsedMs
        : Math.min(result.elapsedMs, analyzePngBytes(readFileSync(file), result.fileName).elapsedMs);
      expect(elapsedMs, result.fileName).toBeLessThan(300);
    }
  });

  test('reads every non-placeholder Siglent MEASURE reading cleanly', () => {
    for (const result of results.values()) {
      for (const reading of result.scopeReadings) {
        if (reading.rawText === '***') expect(reading.value).toBeNull();
        else expect(reading.value, `${result.fileName} ${reading.label}`).toEqual(expect.any(Number));
      }
    }
  });

  test.each([2, 3, 4, 5, 6])('reads both native analog hues on inverted capture %i', index => {
    const result = results.get(`SDS2104X_Plus_PNG_${index}.png`)!;
    expect(result.detection.grid.inverted).toBe(true);
    expect(result.traces.map(trace => trace.channel)).toEqual(['C1', 'C2']);
    for (const trace of result.traces) expect(trace.validCount).toBeGreaterThan(980);
  });

  test('masks yellow callout ink at the center grid line without discarding the C1 sample', () => {
    const name = 'SDS2104X_Plus_PNG_5.png';
    const result = results.get(name)!;
    const image = decodePng(readFileSync(localFiles.find(path => basename(path) === name)!));
    const { grid, profileId } = result.detection;
    const mask = buildOverlayMask(image, grid, profileId);
    expect(mask.pixels[82 * image.width + 519]! & OVERLAY).toBe(OVERLAY);
    expect(mask.pixels[83 * image.width + 519]! & OVERLAY).toBe(OVERLAY);
    const c1 = result.traces.find(trace => trace.channel === 'C1')!;
    expect(c1.samples[519 - grid.left]).toMatchObject({ status: 'ok', voltage: expect.closeTo(-0.17, 1) });
    expect(c1.validCount).toBeGreaterThan(980);
  });

  test('masks the DATA and D0 pills and colored digital ink on the mixed capture', () => {
    const name = 'SDS2104X_Plus_PNG_13.png';
    const file = localFiles.find(path => basename(path) === name)!;
    const image = decodePng(readFileSync(file));
    const result = results.get(name)!;
    const mask = buildOverlayMask(image, result.detection.grid, result.detection.profileId, true);
    expect(result.traces.map(trace => trace.channel)).toEqual(['C1', 'C2']);
    for (const [x, y] of [[22, 240], [1000, 243], [615, 286]] as const) {
      expect(mask.pixels[y * image.width + x]! & OVERLAY).toBe(OVERLAY);
    }
    expect(result.traces.every(trace => trace.samples[615 - 19]?.status === 'masked_overlay')).toBe(true);
  });

  test.each([[1, 'E', 9600], [2, 'A', 9600], [5, 'real', 9600], [7, 'Hello', 115200]] as const)
    ('decodes analog UART capture %i as %s', (index, text, baud) => {
      const result = results.get(`SDS2104X_Plus_PNG_${index}.png`)!;
      const uart = decodeUart(result, { channel: 'C1' });
      expect(uart).toMatchObject({ baud, text, reason: null });
      expect(uart.frames.every(frame => !frame.parityError && !frame.framingError)).toBe(true);
      if (index === 7) expect(uart.rawText).toBe('Hello\n');
    });

  test('reports framing errors with default polarity on inverted UART capture 6', () => {
    const result = results.get('SDS2104X_Plus_PNG_6.png')!;
    const uart = decodeUart(result, { channel: 'C1' });
    expect(uart.frames.filter(frame => frame.framingError)).toHaveLength(2);
    expect(uart.warnings).toContain('framing_errors');
    const inverted = decodeUart(result, { channel: 'C1', idleHigh: false });
    expect(inverted).toMatchObject({ baud: 9600, text: 'port', reason: null });
    expect(inverted.frames.every(frame => !frame.parityError && !frame.framingError)).toBe(true);
  });

  test.each([3, 4])('keeps baud unresolved on Lab 2 capture %i with just one edge', index => {
    const result = results.get(`SDS2104X_Plus_PNG_${index}.png`)!;
    for (const idleHigh of [true, false]) {
      expect(decodeUart(result, { channel: 'C1', idleHigh })).toMatchObject({ reason: 'baud_unresolved', frames: [] });
    }
  });

  test('withholds the Zener C1 fundamental and measures the active filter C2 near three cycles', () => {
    const zener = computeSpectrum(results.get('SDS2104X_Plus_PNG_8.png')!, { channel: 'C1' });
    expect(zener.coverage).toBeCloseTo(0.093, 3);
    expect(zener).toMatchObject({ fundamental: null, thdPct: null, thdReason: 'insufficient_samples' });
    const active = computeSpectrum(results.get('07 - 1.5 kHz.png')!, { channel: 'C2' });
    expect(active.durationSec * active.fundamental!.frequencyHz).toBeCloseTo(2.9996, 4);
    expect(active.thdReason).toBeNull();
    expect(active.thdPct).toBeLessThan(0.5);
  });

  test.each([
    [1, -6.57, 6.67], [2, -6.35, 6.51],
  ])('preserves the Schmitt thresholds on Manip %i', (index, low, high) => {
    const result = results.get(`Manip ${index} Lab 3 Electro.png`)!;
    expect(computeXyPlot(result, 'C1', 'C2').hysteresis).toMatchObject({
      lowThresholdV: expect.closeTo(low, 1), highThresholdV: expect.closeTo(high, 1),
    });
  });

  test('fits local Bode sweep captures cleanly when present', () => {
    if (sweepResults.length < 5) return;
    const sweep = analyzeBodeBatch(sweepResults);
    expect(sweep.acceptedCount).toBe(sweepResults.length);
    expect(sweep.cutoffHz).not.toBeNull();
    expect(sweep.points.every((point) => (point.r2In ?? 0) > 0.995 && (point.r2Out ?? 0) > 0.995)).toBe(true);
  });
});
