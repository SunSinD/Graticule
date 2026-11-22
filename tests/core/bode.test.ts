import { describe, expect, test } from 'vitest';
import { frequencyFromFileName } from '../../src/core/bode.js';
import { measurePhase } from '../../src/core/measurements.js';
import { renderBodeSvg } from '../../src/core/export/svg.js';
import { analyzeBodeBatch, recomputeBodeResult } from '../../src/core/pipeline.js';
import { makeGrid } from '../../src/core/profiles.js';
import type { BodePointOverride, ChannelId, ChannelSettings, ChannelTrace, ExtractionResult, TraceSample } from '../../src/core/types.js';
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

  test('measures the upper-frequency passband of a high-pass sweep', () => {
    const result = analyzeBodeBatch([40, 75, 500, 900, 1100, 14_000, 25_000].map(f =>
      pair(f, 2 / Math.hypot(1, 1000 / f), Math.atan(1000 / f) * 180 / Math.PI)));
    expect(result.passbandGainDb).toBeCloseTo(6.006, 2);
    expect(result.cutoffHz).toBeGreaterThan(980);
    expect(result.cutoffHz).toBeLessThan(1020);
    expect(result.cutoffLowHz).toBe(result.cutoffHz);
    expect(result.cutoffHighHz).toBeNull();
  });

  test('finds both sides of a band-pass response', () => {
    const points = [[100, -10], [1000, 0], [2000, 3], [3000, 3], [4000, 0], [8000, -12]];
    const result = analyzeBodeBatch(points.map(([f, db]) => pair(f!, 10 ** (db! / 20), 0)));
    expect(result.passbandGainDb).toBeCloseTo(3, 10);
    expect(result.cutoffLowHz).toBeCloseTo(1000, 6);
    expect(result.cutoffHighHz).toBeCloseTo(4000, 6);
  });

  test('rejects sparse coverage and long gaps despite a wide timestamp span', () => {
    const extraction = pair(1000, 1, 20, { cycles: 4, columns: 800 });
    function withMask(keep: (col: number) => boolean): ExtractionResult {
      return { ...extraction, traces: extraction.traces.map(trace => ({
        ...trace,
        samples: trace.samples.map(sample => keep(sample.col) ? sample
          : { ...sample, yPx: null, voltage: null, status: 'masked_overlay' }),
      })) };
    }
    for (const capture of [
      withMask(col => col < 65 || col === 800),
      withMask(col => col < 350 || col > 400),
      withMask(col => col % 2 === 0),
    ]) {
      const point = analyzeBodeBatch([capture]).points[0]!;
      expect(point).toMatchObject({ accepted: false, gainDb: null, phaseDeg: null });
      expect(point.rejectionReasons).toContain('insufficient_shared_coverage');
      expect(measurePhase(capture.traces, 1000)).toMatchObject({ phaseDeg: null, reason: 'insufficient_shared_samples' });
    }
  });

  test('checks Nyquist and requires at least one full cycle with loosened gates', () => {
    const extraction = pair(100, 1, -60, { cycles: 4, columns: 40, fileName: '900Hz.png' });
    const result = analyzeBodeBatch([extraction], { minColsPerCycle: 1, minR2: 0 });
    expect(result.points[0]).toMatchObject({ accepted: false, r2In: null, phaseDeg: null });
    expect(result.points[0]!.rejectionReasons).toContain('nyquist_limit');
    expect(measurePhase(extraction.traces, 900)?.phaseDeg).toBeNull();
    const short = pair(1000, 1, 15, { cycles: 0.9 });
    expect(analyzeBodeBatch([short], { minCycles: 0.1 }).points[0]!.accepted).toBe(false);
  });

  test('honors minR2 of zero and rescues automatic failures with finite manual measurements', () => {
    const badFit = pair(1000, 0.6, -30, { distortion: 0.6 });
    const failed = analyzeBodeBatch([badFit]);
    expect(failed.points[0]!.accepted).toBe(false);
    expect(analyzeBodeBatch([badFit], { minR2: 0 }).points[0]!.accepted).toBe(true);
    const rescue = (edit: BodePointOverride) => recomputeBodeResult(failed, { [badFit.fileName]: edit }).points[0];
    expect(rescue({ phaseDeg: -15 })).toMatchObject({ accepted: true, phaseDeg: -15, warnings: ['manual_measurement'] });
    expect(rescue({ vinVpp: 4, voutVpp: 2 })).toMatchObject({ accepted: true, vinVpp: 4, voutVpp: 2 });
    expect(rescue({ gainDb: -7.5 })).toMatchObject({ accepted: true, gainDb: -7.5 });
    expect(rescue({ gainDb: -7.5, excluded: true })).toMatchObject({ accepted: false });
    expect(rescue({ gainDb: Infinity })).toMatchObject({ accepted: false });
    const noTraces = { ...badFit, traces: [] };
    expect(analyzeBodeBatch([noTraces], {}, { [noTraces.fileName]: { gainDb: 0, phaseDeg: 0 } }).points[0])
      .toMatchObject({ accepted: true, gainDb: 0, phaseDeg: 0 });
    const noFrequency = { ...noTraces, fileName: 'empty.png' };
    expect(analyzeBodeBatch([noFrequency], {}, { 'empty.png': { gainDb: 0 } }).points[0])
      .toMatchObject({ accepted: false, frequencyHz: null });
  });

  test('draws separate Bode path segments at rejected rows and phase wraps, with optional grids', () => {
    const batch = analyzeBodeBatch([pair(10, 1, 10), pair(20, 1, 10), pair(30, 1, 10), pair(40, 1, 170), pair(50, 1, -170), pair(60, 1, -155)]);
    const result = recomputeBodeResult(batch, { '30 Hz.png': { excluded: true } });
    const svg = renderBodeSvg(result, { showGrid: false });
    expect(svg).not.toMatch(/#(?:d4d4d4|e5e5e5)/);
    expect(renderBodeSvg(result)).toMatch(/#(?:d4d4d4|e5e5e5)/);
    const plots = [...svg.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]!);
    expect(plots).toHaveLength(2);
    expect(plots[0]!.match(/M/g)).toHaveLength(2);
    expect(plots[1]!.match(/M/g)).toHaveLength(3);
  });

  test('keeps the Bode SVG finite with widely separated manual gains', () => {
    const result = analyzeBodeBatch([pair(10, 1, 0), pair(20, 1, 0)], {}, {
      '10 Hz.png': { gainDb: -1e308 }, '20 Hz.png': { gainDb: 1e308 },
    });
    expect(result.acceptedCount).toBe(2);
    const svg = renderBodeSvg(result);
    expect(svg).not.toMatch(/(?:Infinity|NaN)/);
    expect(svg.length).toBeLessThan(20_000);
  });
});

test.each([
  ['10mHz.png', 0.01], ['10MHz.PNG', 10_000_000], ['-20Hz.png', null], ['sweep -20 Hz.png', null],
  ['1e3Hz.png', 1000], ['osc_1.2e+3Hz.png', 1200], ['.2kHz.png', 200], ['2,5 kHz.png', 2500],
  ['10µHz.png', 1e-5], ['1KHz.png', null], ['/archive/500Hz/capture.png', null],
] as const)('reads only positive complete frequency tokens in %s', (name, expected) => {
  expect(frequencyFromFileName(name)).toBe(expected);
});

test('audits all ten bundled Siglent sweep captures by frequency, gain, phase, and passband cutoff', () => {
  const truth = audit.bodeSweep;
  const result = analyzeBodeBatch(truth.points.map(({ fileName }) => ({ fileName, bytes: sample(fileName) })));
  expect(result.acceptedCount).toBe(10);
  expect(result.rejectedCount).toBe(0);
  expect(Math.abs(result.passbandGainDb! - truth.summary.passbandGainDbSineFit)).toBeLessThan(0.01);
  expect(Math.abs(result.cutoffHz! - 990)).toBeLessThan(2);
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
