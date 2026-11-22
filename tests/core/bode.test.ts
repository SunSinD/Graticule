import { describe, expect, test } from 'vitest';
import { analyzeBodeBatch, recomputeBodeResult } from '../../src/core/pipeline.js';
import { makeGrid } from '../../src/core/profiles.js';
import type { ChannelId, ChannelSettings, ChannelTrace, ExtractionResult, TraceSample } from '../../src/core/types.js';
import audit from '../fixtures/manual-audit.json';
import { sample } from './fixtures.js';

interface SineOptions {
  readonly cycles?: number;
  readonly columns?: number;
  readonly outputPx?: number;
  readonly clipped?: boolean;
  readonly distortion?: number;
  readonly fileName?: string;
}

function pair(frequencyHz: number, gain: number, phase: number, options: SineOptions = {}): ExtractionResult {
  const { cycles = 4, columns = 400, outputPx = 50, clipped = false, distortion = 0, fileName = `${frequencyHz} Hz.png` } = options;
  const grid = makeGrid(0, 0, columns, 240, 10, 8, 'manual', false);
  const traces: ChannelTrace[] = (['C1', 'C2'] as const).map((channel: ChannelId, i) => {
    const settings: ChannelSettings = {
      channel, enabled: true, voltsPerDiv: i ? gain * 45 / outputPx : 1, offsetVolts: 0, zeroY: 120, probeAttenuation: 1,
      coupling: 'DC', scaleSource: 'manual', zeroSource: 'manual', rawScaleText: null, rawOffsetText: null,
    };
    const samples = Array.from({ length: columns + 1 }, (_, col): TraceSample => {
      const cycle = col * cycles / columns;
      const angle = 2 * Math.PI * cycle + (i ? phase / 180 * Math.PI : 0);
      const yPx = 120 - (i ? outputPx : 45) * (Math.cos(angle) + (i ? distortion * Math.cos(3 * angle) : 0));
      const timeSec = cycle / frequencyHz;
      if (i && clipped && col < 8) return { col, xPx: col, yPx: null, timeSec, voltage: null, status: 'clipped_high' };
      return { col, xPx: col, yPx, timeSec, voltage: (120 - yPx) * settings.voltsPerDiv / 30, status: 'ok' };
    });
    return { channel, settings, samples, validCount: samples.filter(s => s.status === 'ok').length,
      clippedCount: i && clipped ? 8 : 0, maskedCount: 0, overlapCount: 0, unresolvedCount: 0, medianThicknessPx: 1 };
  });
  return {
    fileName, imageWidth: columns + 1, imageHeight: 241,
    detection: { profileId: 'universal-fallback', profileName: 'Universal Fallback', matchedAnchors: [], confidence: 0,
      fallbackReason: 'manual_crop', grid, digitalOnly: false, warnings: [] },
    timebase: { secPerDiv: cycles / (10 * frequencyHz), triggerOffsetSec: 0, source: 'manual', rawText: null },
    topFrequencyHz: null, topFrequencyRaw: null, traces, measurements: [], phaseC1ToC2: null, scopeReadings: [],
    comparisons: [], maskCoveragePct: 0, elapsedMs: 0,
  };
}

describe('Bode sine fit', () => {
  const response = (f: number) => pair(f, 2 / Math.hypot(1, f / 1000), -Math.atan(f / 1000) * 180 / Math.PI);

  test('recovers gain, lag, flat passband and a log-interpolated cutoff', () => {
    const result = analyzeBodeBatch([2300, 900, 40, 75, 1100, 500].map(response));
    expect(result.acceptedCount).toBe(6);
    expect(result.passbandGainDb).toBeCloseTo(6.005, 2);
    expect(result.cutoffHz).toBeGreaterThan(990);
    expect(result.cutoffHz).toBeLessThan(1020);
    expect(result.points[3]!.frequencyHz).toBe(900);
    expect(result.points[3]!.gainDb).toBeCloseTo(20 * Math.log10(2 / Math.hypot(1, 0.9)), 7);
    expect(result.points[3]!.phaseDeg).toBeCloseTo(-41.9872, 4);
  });

  test.each([
    [{ cycles: 1.25 }, 'insufficient_cycles'],
    [{ cycles: 10, columns: 110 }, 'insufficient_cols_per_cycle'],
    [{ outputPx: 5.5 }, 'insufficient_peak_to_peak_px'],
    [{ clipped: true }, 'clipped_channel'],
    [{ distortion: 0.5 }, 'poor_sine_fit'],
  ] as const)('rejects %j with %s', (options, reason) => {
    const result = analyzeBodeBatch([pair(1000, 0.707, -45, options)]);
    expect(result.points[0]).toMatchObject({ accepted: false, rejectionReasons: expect.arrayContaining([reason]) });
  });

  test('accepts 2 cycles with a warning, retains strict options in recomputation', () => {
    const extraction = pair(1000, 0.707, -45, { cycles: 2 });
    const base = analyzeBodeBatch([extraction]);
    expect(base.points[0]).toMatchObject({ accepted: true, warnings: ['fewer_than_3_cycles'] });
    const strict = analyzeBodeBatch([extraction], { minCycles: 3 });
    expect(recomputeBodeResult(strict).points[0]!.rejectionReasons).toContain('insufficient_cycles');
  });

  test('uses scope, then waveform, then filename, then manual frequency', () => {
    const p = pair(1000, 0.707, -45, { fileName: 'Hint 950 Hz.png' });
    const m = {
      channel: 'C1' as const, frequencyHz: 990, periodSec: 1 / 990, vpp: null, vmin: null, vmax: null, vavg: null,
      vrms: null, dutyCyclePct: null, clipped: false, completeCycles: 3,
    };
    const edits = { [p.fileName]: { frequencyHz: 910 }, 'unnamed.png': { frequencyHz: 1000 } };
    expect(analyzeBodeBatch([{ ...p, topFrequencyHz: 1000, topFrequencyRaw: 'f(C1)=1kHz', measurements: [m] }], {}, edits)
      .points[0]!.frequencySource).toBe('scope');
    expect(analyzeBodeBatch([{ ...p, measurements: [m] }], {}, edits).points[0]).toMatchObject({ frequencyHz: 990, frequencySource: 'waveform' });
    expect(analyzeBodeBatch([p], {}, edits).points[0]).toMatchObject({ frequencyHz: 950, frequencySource: 'filename' });
    expect(analyzeBodeBatch([{ ...p, fileName: 'unnamed.png' }], {}, edits).points[0]).toMatchObject({ frequencyHz: 1000, frequencySource: 'manual' });
  });

  test('recomputes live amplitude, phase, edited frequency, and excludes cutoff interpolation across rejected rows', () => {
    const base = analyzeBodeBatch([40, 75, 900, 1100, 2000].map(response));
    expect(base.cutoffHz).not.toBeNull();
    const row = base.points[2]!;
    const excluded = base.points[3]!;
    const edited = recomputeBodeResult(base, {
      [row.id]: { frequencyHz: 910, vinVpp: 2, voutVpp: 4, phaseDeg: -225 },
      [excluded.id]: { excluded: true },
    });
    expect(edited.points[2]).toMatchObject({
      frequencyHz: 910, frequencySource: 'manual', vinVpp: 2, voutVpp: 4, phaseDeg: 135, edited: true,
    });
    expect(edited.points[2]!.gainDb).toBeCloseTo(6.0206, 4);
    expect(edited.points[3]).toMatchObject({ accepted: false, rejectionReasons: ['manually_excluded'] });
    expect(edited.cutoffHz).toBeNull();
    expect(base.points[2]!.frequencyHz).toBe(900);
  });
});

test('audits all ten bundled Siglent sweep captures by frequency, gain, phase, and passband cutoff', () => {
  const truth = audit.bodeSweep;
  const result = analyzeBodeBatch(truth.points.map(({ fileName }) => ({ fileName, bytes: sample(fileName) })));
  expect(result.acceptedCount).toBe(10);
  expect(result.rejectedCount).toBe(0);
  expect(result.passbandGainDb).toBeCloseTo(truth.summary.passbandGainDbSineFit, 1);
  expect(Math.abs(result.cutoffHz! - truth.summary.cutoffHzSineFitMinus3Db)).toBeLessThan(5);
  for (const [index, point] of result.points.entries()) {
    const expected = truth.points[index]!;
    expect(point.frequencySource).toBe('scope');
    expect(point.frequencyHz).toBeCloseTo(expected.measureBarFrequencyHz, 5);
    expect(Math.abs(point.cycles - expected.cycles)).toBeLessThan(0.015);
    expect(Math.abs(point.gainDb! - expected.gainDbSineFit)).toBeLessThan(0.15);
    expect(Math.abs(point.phaseDeg! - expected.phaseDeg)).toBeLessThan(0.15);
    expect(point.r2In).toBeGreaterThan(0.995);
    expect(point.r2Out).toBeGreaterThan(0.995);
  }
  expect(result.points[0]!.warnings).toContain('fewer_than_3_cycles');
  expect(result.points[1]!.warnings).toContain('fewer_than_3_cycles');
  expect(result.points[3]!.warnings).toContain('fewer_than_3_cycles');
  expect(result.elapsedMs).toBeLessThan(2000);
});
