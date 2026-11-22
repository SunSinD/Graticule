import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { analyzeBodeBatch, analyzePngBytes } from '../../src/core/pipeline.js';
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
    for (const filePath of localFiles) {
      const name = basename(filePath);
      const result = analyzePngBytes(readFileSync(filePath), name);
      results.set(name, result);
      if (/^\d{2}\s*-\s*[\d.]+\s*[kM]?Hz\.png$/i.test(name)) {
        sweepResults.push(result);
      }
    }
  }, 15_000);

  test('matches native profile, timebase OCR, active channels, and stays under 300 ms per capture', () => {
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
      expect(result.elapsedMs, result.fileName).toBeLessThan(300);
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

  test('fits local Bode sweep captures cleanly when present', () => {
    if (sweepResults.length < 5) return;
    const sweep = analyzeBodeBatch(sweepResults);
    expect(sweep.acceptedCount).toBe(sweepResults.length);
    expect(sweep.cutoffHz).not.toBeNull();
    expect(sweep.points.every((point) => (point.r2In ?? 0) > 0.995 && (point.r2Out ?? 0) > 0.995)).toBe(true);
  });
});
