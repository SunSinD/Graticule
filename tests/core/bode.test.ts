import { describe, expect, test } from 'vitest';
import { frequencyFromFileName } from '../../src/core/bode.js';
import { measureChannel, measurePhase } from '../../src/core/measurements.js';
import { renderBodeCsv } from '../../src/core/export/csv.js';
import { renderBodeSvg } from '../../src/core/export/svg.js';
import { renderBodeTable } from '../../src/core/export/table.js';
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

  test('rejects confirmed input and output frequencies that differ by more than 1%', () => {
    const capture = pair(1000, 2, -20);
    const measurements = capture.traces.map(trace => measureChannel(trace, capture.detection.grid.pxPerVDiv));
    const at = (frequencyHz: number) => ({
      ...capture, measurements: [{ ...measurements[0]!, frequencyHz: 1000 }, { ...measurements[1]!, frequencyHz }],
    });
    expect(analyzeBodeBatch([at(1010)]).points[0]?.accepted).toBe(true);
    expect(analyzeBodeBatch([at(1020)]).points[0])
      .toMatchObject({ accepted: false, phaseDeg: null, rejectionReasons: ['frequency_mismatch'] });
  });

  test('keeps valid captures when individual PNGs fail decoding or analysis', () => {
    const png = sample('sine_schmitt.png');
    const batch = analyzeBodeBatch([
      { fileName: 'corrupt 1 kHz.png', bytes: new Uint8Array([1, 2, 3]) },
      { fileName: 'invalid calibration.png', bytes: png, overrides: { secPerDiv: Number.MAX_VALUE } },
      { fileName: 'valid 2 kHz.png', bytes: png },
    ]);
    expect(batch.points).toHaveLength(3);
    expect(batch.points.find(point => point.fileName === 'valid 2 kHz.png')?.extraction).not.toBeNull();
    for (const name of ['corrupt 1 kHz.png', 'invalid calibration.png']) {
      expect(batch.points.find(point => point.fileName === name)).toMatchObject({ extraction: null, accepted: false,
        baseReason: 'capture_unreadable', rejectionReasons: ['capture_unreadable'] });
    }
  });

  test('rescues unreadable captures with manual measurements and restores their reason when edits are reset', () => {
    const fileName = 'capture 1 kHz.png';
    const capture = { fileName, rejectionReason: 'capture_unreadable' };
    const edit = { frequencyHz: 1200, vinVpp: 1, voutVpp: 2, phaseDeg: 270 };
    const base = analyzeBodeBatch([capture], {}, { [fileName]: edit });
    expect(base.points[0]).toMatchObject({ frequencyHz: 1000, frequencySource: 'filename', accepted: true });
    expect(analyzeBodeBatch([capture], { preferManualFrequency: true }, { [fileName]: edit }).points[0])
      .toMatchObject({ frequencyHz: 1200, frequencySource: 'manual' });
    const edited = recomputeBodeResult(base, new Map([[fileName, edit]]));
    expect(edited.acceptedCount).toBe(1);
    expect(edited.points[0]).toMatchObject({ frequencyHz: 1200, frequencySource: 'manual', vinVpp: 1, voutVpp: 2, phaseDeg: -90,
      baseReason: 'capture_unreadable', accepted: true, warnings: ['manual_measurement'], rejectionReasons: [], edited: true, override: edit });
    expect(edited.points[0]!.gainDb).toBeCloseTo(20 * Math.log10(2));
    expect(recomputeBodeResult(edited, { minR2: 0.9 }).points[0]!.frequencyHz).toBe(1200);
    const reset = recomputeBodeResult(edited, new Map());
    expect(reset.points[0]).toMatchObject({ frequencyHz: 1000, gainDb: null, accepted: false, edited: false,
      rejectionReasons: ['capture_unreadable'] });
    expect(reset.points[0]!.override).toBeUndefined();
  });

  test('requires manual gain on an unreadable row and clears pair-specific edits when channels change', () => {
    const fileName = 'unreadable.png';
    const base = analyzeBodeBatch([{ fileName, rejectionReason: 'capture_unreadable' }]);
    const edit = { frequencyHz: 1200, vinVpp: 1, voutVpp: 2, gainDb: -5, phaseDeg: 42 };
    expect(recomputeBodeResult(base, { [fileName]: { frequencyHz: 1200, vinVpp: 2, phaseDeg: 42 } }).points[0])
      .toMatchObject({ accepted: false, gainDb: null, rejectionReasons: ['capture_unreadable'] });
    expect(analyzeBodeBatch([{ fileName, rejectionReason: 'capture_unreadable' }], { outputChannel: 'C1' }, { [fileName]: edit }).points[0])
      .toMatchObject({ accepted: false, gainDb: -5, rejectionReasons: ['capture_unreadable'] });
    const excluded = recomputeBodeResult(base, { [fileName]: { ...edit, excluded: true } });
    expect(excluded.points[0]).toMatchObject({ accepted: false, gainDb: -5, rejectionReasons: ['capture_unreadable', 'manually_excluded'] });
    const changed = recomputeBodeResult(excluded, { outputChannel: 'C3' });
    expect(changed.points[0]).toMatchObject({ frequencyHz: 1200, frequencySource: 'manual', vinVpp: null, voutVpp: null,
      gainDb: null, phaseDeg: null, edited: true, override: { frequencyHz: 1200, excluded: true } });
    expect(changed.points[0]!.override).toEqual({ frequencyHz: 1200, excluded: true });
  });

  test.each([1e155, 1e-170])('preserves gain and R² when both fitted channels are rescaled by %s', scale => {
    const capture = pair(1000, 0.7, -35, { distortion: 0.08 });
    const reference = analyzeBodeBatch([capture]).points[0]!;
    const traces = capture.traces.map(trace => ({ ...trace,
      settings: { ...trace.settings, voltsPerDiv: trace.settings.voltsPerDiv * scale },
      samples: trace.samples.map(point => ({ ...point, voltage: point.voltage === null ? null : point.voltage * scale })),
    }));
    const fitted = analyzeBodeBatch([{ ...capture, traces }]).points[0]!;
    expect(fitted.accepted).toBe(true);
    expect(fitted.gainDb).toBeCloseTo(reference.gainDb!, 10);
    expect(fitted.r2In).toBeCloseTo(reference.r2In!, 12);
    expect(fitted.r2Out).toBeCloseTo(reference.r2Out!, 12);
  });

  test('fits a finite angle when angular frequency would overflow', () => {
    const fitted = analyzeBodeBatch([pair(5e307, 0.8, -40)]).points[0]!;
    expect(fitted.accepted).toBe(true);
    expect(fitted.gainDb).toBeCloseTo(20 * Math.log10(0.8), 9);
    expect(fitted.phaseDeg).toBeCloseTo(-40, 9);
  });

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

  test('finds both sides of a band-stop response', () => {
    const points = [[100, 0], [200, -3], [300, -20], [400, -3], [500, 0]] as const;
    const result = analyzeBodeBatch(points.map(([f]) => pair(f, 1, 0)), {},
      Object.fromEntries(points.map(([f, gainDb]) => [`${f} Hz.png`, { gainDb }])));
    expect(result).toMatchObject({ passbandGainDb: 0, cutoffLowHz: 200, cutoffHighHz: 400 });
  });

  test('pairs the two crossings of the first complete notch in a multi-notch sweep', () => {
    const rows = [[100, 0], [200, -6], [400, 0], [800, -6], [1600, 0]] as const;
    const result = analyzeBodeBatch(rows.map(([f]) => pair(f, 1, 0)), {},
      Object.fromEntries(rows.map(([f, gainDb]) => [`${f} Hz.png`, { gainDb }])));
    expect(result.cutoffLowHz).toBeCloseTo(100 * Math.SQRT2, 9);
    expect(result.cutoffHighHz).toBeCloseTo(200 * Math.SQRT2, 9);
  });

  test('keeps a cutoff whose two bracketing frequencies are both observed after an unreadable capture', () => {
    const result = analyzeBodeBatch([
      pair(100, 1, 0), { fileName: '200 Hz.png', rejectionReason: 'capture_unreadable' }, pair(400, 1, 0), pair(800, 1, 0),
    ], {}, { '400 Hz.png': { gainDb: -1 }, '800 Hz.png': { gainDb: -5 } });
    expect(result.cutoffHighHz).toBeCloseTo(400 * Math.SQRT2, 9);
    expect(recomputeBodeResult(result).points[1]).toMatchObject({
      frequencyHz: 200, accepted: false, rejectionReasons: ['capture_unreadable'], extraction: null,
    });
  });

  test('does not report a later bounce once the response already fell below target across a rejected gap', () => {
    const result = analyzeBodeBatch([
      pair(100, 1, 0), { fileName: '200 Hz.png', rejectionReason: 'capture_unreadable' },
      pair(400, 1, 0), pair(800, 1, 0), pair(1600, 1, 0),
    ], {}, { '400 Hz.png': { gainDb: -10 }, '800 Hz.png': { gainDb: 0 }, '1600 Hz.png': { gainDb: -10 } });
    expect(result).toMatchObject({ passbandGainDb: 0, cutoffLowHz: null, cutoffHighHz: null, cutoffHz: null });
  });

  test('averages accepted gains at duplicate frequencies before interpolation', () => {
    const points = [[100, 0], [200, 0], [200, -8], [200, 12], [400, -10]] as const;
    const rows = points.map(([frequencyHz, gainDb], index) => ({
      capture: pair(frequencyHz, 1, 0, { fileName: `${frequencyHz} Hz sample ${index}.png` }),
      edit: { gainDb, excluded: index === 3 },
    }));
    const overrides = Object.fromEntries(rows.map(({ capture, edit }) => [capture.fileName, edit]));
    for (const order of [rows, [...rows].reverse()]) {
      const result = analyzeBodeBatch(order.map(({ capture }) => capture), {}, overrides);
      expect(result).toMatchObject({ acceptedCount: 4, rejectedCount: 1, cutoffLowHz: null });
      expect(result.cutoffHighHz).toBeCloseTo(100 * 2 ** 0.75, 9);
    }
  });

  test('connects aggregate gain and phase at duplicate frequencies despite an excluded row', () => {
    const rows = [[100, 0, -175], [200, 0, 170], [200, 12, 0], [200, -8, -170], [400, -10, -170]] as const;
    const captures = rows.map(([f], index) => pair(f, 1, 0, { fileName: `${f} Hz sample ${index}.png` }));
    const edits = Object.fromEntries(rows.map(([, gainDb, phaseDeg], i) =>
      [captures[i]!.fileName, { gainDb, phaseDeg, excluded: i === 2 }]));
    const result = analyzeBodeBatch(captures, {}, edits);
    const duplicate = result.points[1]!;
    const reference = { ...result, points: [
      ...result.points.map(point => point.frequencyHz === 200 ? { ...point, accepted: false } : point),
      { ...duplicate, gainDb: -4, phaseDeg: -180 },
    ] };
    const paths = (sweep: typeof result) => [...renderBodeSvg(sweep).matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
    expect(paths(result)).toEqual(paths(reference));
    expect(paths(result)).toHaveLength(2);
    for (const path of paths(result)) expect(path).toMatch(/^M[^ML]+L[^ML]+L[^ML]+$/);
    expect(paths({ ...result, points: [...result.points].reverse() })).toEqual(paths(result));
  });

  test('keeps live point edits through repeated gate-only recalculations', () => {
    const base = analyzeBodeBatch([pair(100, 1, 0), pair(200, 1, 0)]);
    const edits = new Map([['100 Hz.png', { frequencyHz: 101, vinVpp: 2, voutVpp: 4, gainDb: 5, phaseDeg: -15 }],
      ['200 Hz.png', { excluded: true }]]);
    const edited = recomputeBodeResult(base, edits);
    const changed = recomputeBodeResult(edited, { minR2: 0.97 });
    for (const result of [changed, recomputeBodeResult(changed, undefined, { minCycles: 2 })]) {
      expect(result.points[0]).toMatchObject({ frequencyHz: 101, vinVpp: 2, voutVpp: 4, gainDb: 5, phaseDeg: -15, edited: true });
      expect(result.points[1]!.rejectionReasons).toContain('manually_excluded');
    }
    expect(changed.gateOptions?.minR2).toBe(0.97);
    expect(recomputeBodeResult(changed, new Map()).points.every(point => !point.edited)).toBe(true);
    for (const gate of [{}, { minR2: undefined, minCycles: undefined }]) {
      const unchanged = recomputeBodeResult(changed, gate);
      expect(unchanged.points.map(point => point.override)).toEqual(changed.points.map(point => point.override));
      expect(unchanged.gateOptions).toEqual(changed.gateOptions);
    }
  });

  test.each([false, true])('clears old channel-pair measurements when the pair changes (explicit edits %s)', explicit => {
    const base = analyzeBodeBatch([pair(100, 1, 30), pair(200, 1, 30)]);
    const edits = { '100 Hz.png': { frequencyHz: 101, vinVpp: 2, voutVpp: 4, gainDb: 5, phaseDeg: -15 },
      '200 Hz.png': { gainDb: 5, excluded: true } };
    const edited = recomputeBodeResult(base, edits);
    const gate = { inputChannel: 'C3', outputChannel: 'C4' } as const;
    const updated = explicit ? recomputeBodeResult(edited, edits, gate) : recomputeBodeResult(edited, gate);
    expect(updated).toMatchObject({ inputChannel: 'C3', outputChannel: 'C4', acceptedCount: 0, rejectedCount: 2 });
    expect(updated.points[0]).toMatchObject({
      frequencyHz: 101, frequencySource: 'manual', accepted: false, rejectionReasons: ['missing_channels'],
      vinVpp: null, voutVpp: null, gainDb: null, phaseDeg: null,
    });
    expect(updated.points[0]!.override).toEqual({ frequencyHz: 101 });
    expect(updated.points[1]!.override).toEqual({ excluded: true });
    expect(updated.points[1]!.rejectionReasons).toContain('manually_excluded');
    expect(edited.points[0]!.override).toEqual(edits['100 Hz.png']);
  });

  test('keeps the original batch duration during all recomputation calls', () => {
    const base = { ...analyzeBodeBatch([pair(100, 1, 0)]), elapsedMs: 321.25 };
    expect(recomputeBodeResult(base).elapsedMs).toBe(321.25);
    expect(recomputeBodeResult(base, { minR2: 0.9 }).elapsedMs).toBe(321.25);
    expect(recomputeBodeResult(base, { '100 Hz.png': { gainDb: 5 } }).elapsedMs).toBe(321.25);
  });

  test('keeps a live manual frequency when extracts are rebuilt for another profile', () => {
    const capture = { bytes: sample('sweep_04.png'), fileName: '1000 Hz.png' };
    const edits = { [capture.fileName]: { frequencyHz: 990 } };
    const initial = analyzeBodeBatch([capture], {}, edits);
    expect(initial.points[0]!.frequencySource).toBe('scope');
    const live = recomputeBodeResult(initial, { preferManualFrequency: true });
    expect(live.points[0]).toMatchObject({ frequencyHz: 990, frequencySource: 'manual' });
    const refreshed = analyzeBodeBatch([{ ...capture, overrides: { profileId: 'universal-fallback' } }],
      { preferManualFrequency: true }, { [capture.fileName]: live.points[0]!.override });
    expect(refreshed.points[0]).toMatchObject({ frequencyHz: 990, frequencySource: 'manual' });
    expect(refreshed.points[0]!.extraction?.detection.profileId).toBe('universal-fallback');
    expect(recomputeBodeResult(refreshed, { minR2: 0.95 }).points[0]!.frequencyHz).toBe(990);
  });

  test('accepts a clean 12-column sine even when floating point rounds the density slightly lower', () => {
    const capture = pair(1000, 1, 30, { columns: 48 });
    const result = analyzeBodeBatch([{ ...capture, traces: capture.traces.map(trace => ({
      ...trace, samples: trace.samples.map(sample => ({ ...sample, timeSec: sample.timeSec * (1 + 8e-16) })),
    })) }]);
    expect(result.points[0]!.colsPerCycle).toBeLessThan(12);
    expect(result.points[0]!.accepted).toBe(true);
  });

  test.each(['low', 'high'] as const)('labels a single %s cutoff in all exports', side => {
    const base = analyzeBodeBatch([pair(100, 1, 0)]);
    const result = { ...base, cutoffHz: 100, cutoffLowHz: side === 'low' ? 100 : null, cutoffHighHz: side === 'high' ? 100 : null };
    const other = side === 'low' ? 'high' : 'low';
    const label = side === 'low' ? 'Lower' : 'Upper';
    const csv = renderBodeCsv(result);
    expect(csv).toContain(`# cutoff_${side}_hz_minus_3db: 100`);
    expect(csv).not.toContain(`# cutoff_${other}_hz_minus_3db`);
    expect(renderBodeTable(result, 'tsv', 'en')).toContain(`${label} cutoff frequency (-3 dB)\t`);
    expect(renderBodeSvg(result)).toContain(`aria-label="${label} cutoff frequency (-3 dB)"`);
  });

  test('keeps Bode tick coordinates finite for subnormal and near-maximum frequencies', () => {
    const base = analyzeBodeBatch([pair(100, 1, 0), pair(200, 1, 0)]);
    const result = { ...base, points: base.points.map((point, index) => ({ ...point, frequencyHz: index ? 1e308 : 5e-324 })) };
    for (const sweep of [result, ...result.points.map(point => ({ ...result, points: [point] }))]) {
      expect(renderBodeSvg(sweep)).not.toMatch(/(?:Infinity|NaN)/);
    }
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
  ['01 - 500 Hz.png', 500], ['01 - -500 Hz.png', null], ['-500Hz.png', null],
  ['sweep-1kHz.png', 1000], ['sweep--1kHz.png', null], ['sweep-1e-3Hz.png', 0.001],
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
  expect(result.elapsedMs).toBeLessThan(process.env.CI ? 5000 : 2500);
});
