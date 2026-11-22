import { fitShared, wrapPhase } from './dsp.js';
import { parseEngineering } from './export/format.js';
import { scopeFrequency } from './measurements.js';
import type { BodeGateOptions, BodePoint, BodePointOverride, BodeResult, ExtractionResult } from './types.js';

export type BodeOverrides = Readonly<Record<string, BodePointOverride | undefined>> | ReadonlyMap<string, BodePointOverride>;

const defaults: Required<BodeGateOptions> = {
  inputChannel: 'C1', outputChannel: 'C2', minCycles: 1.5, minColsPerCycle: 12, minPeakToPeakPx: 12, minR2: 0.96,
};

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function gates(options: BodeGateOptions): Required<BodeGateOptions> {
  const minR2 = options.minR2 ?? defaults.minR2;
  return {
    inputChannel: options.inputChannel ?? defaults.inputChannel,
    outputChannel: options.outputChannel ?? defaults.outputChannel,
    minCycles: positive(options.minCycles) ? options.minCycles : defaults.minCycles,
    minColsPerCycle: positive(options.minColsPerCycle) ? options.minColsPerCycle : defaults.minColsPerCycle,
    minPeakToPeakPx: positive(options.minPeakToPeakPx) ? options.minPeakToPeakPx : defaults.minPeakToPeakPx,
    minR2: minR2 >= 0 && minR2 <= 1 ? minR2 : defaults.minR2,
  };
}

export function frequencyFromFileName(name: string): number | null {
  const baseName = name.split(/[/\\]/).at(-1) ?? '';
  const tokens = /(?:^|[^\d.,+\-\u2212])([+\-\u2212]?\s*(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+\-]?\d+)?\s*[pnuµμmkMG]?\s*[Hh][Zz])(?=$|[^A-Za-z])/g;
  for (const [, token] of baseName.matchAll(tokens)) {
    const frequency = parseEngineering(token!);
    if (positive(frequency)) return frequency;
  }
  return null;
}

function overrideFor(overrides: BodeOverrides, id: string): BodePointOverride | undefined {
  if (overrides instanceof Map) return overrides.get(id);
  return Object.hasOwn(overrides, id) ? (overrides as Readonly<Record<string, BodePointOverride | undefined>>)[id] : undefined;
}

function evaluate(extraction: ExtractionResult, id: string, options: Required<BodeGateOptions>, edit: BodePointOverride | undefined,
  live: boolean): BodePoint {
  const { inputChannel, outputChannel } = options;
  const input = extraction.traces.find(trace => trace.channel === inputChannel);
  const output = extraction.traces.find(trace => trace.channel === outputChannel);
  const scope = scopeFrequency(extraction.scopeReadings, inputChannel, extraction.topFrequencyHz, extraction.topFrequencyRaw);
  const waveform = extraction.measurements.find(measurement => measurement.channel === inputChannel)?.frequencyHz;
  const hint = frequencyFromFileName(extraction.fileName);
  const manual = edit?.frequencyHz;
  const candidates: (readonly [number | null | undefined, BodePoint['frequencySource']])[] = [
    [scope, 'scope'], [waveform, 'waveform'], [hint, 'filename'], [manual, 'manual'],
  ];
  if (live) candidates.unshift([manual, 'manual']);
  const frequency = candidates.find(([value]) => positive(value));
  const frequencyHz = frequency?.[0] ?? null;
  const frequencySource = frequency?.[1] ?? 'none';
  const fit = input && output && frequencyHz ? fitShared(input, output, frequencyHz) : null;
  const cycles = fit?.cycles ?? 0;
  const colsPerCycle = fit?.colsPerCycle ?? 0;
  const vinPx = fit?.vinPx ?? 0;
  const voutPx = fit?.voutPx ?? 0;
  const r2In = fit?.input?.r2 ?? null;
  const r2Out = fit?.output?.r2 ?? null;
  const vinVpp = positive(edit?.vinVpp) ? edit.vinVpp : fit?.input ? fit.input.amplitude * 2 : null;
  const voutVpp = positive(edit?.voutVpp) ? edit.voutVpp : fit?.output ? fit.output.amplitude * 2 : null;
  const gainDb = typeof edit?.gainDb === 'number' && Number.isFinite(edit.gainDb) ? edit.gainDb
    : positive(vinVpp) && positive(voutVpp) ? 20 * (Math.log10(voutVpp) - Math.log10(vinVpp)) : null;
  const manualPhase = typeof edit?.phaseDeg === 'number' && Number.isFinite(edit.phaseDeg) ? wrapPhase(edit.phaseDeg) : null;

  const rejectionReasons: string[] = [];
  const warnings: string[] = [];
  const minCycles = Math.max(1, options.minCycles);
  if (!input || !output || inputChannel === outputChannel) rejectionReasons.push('missing_channels');
  if (!frequencyHz) rejectionReasons.push('frequency_unconfirmed');
  if (extraction.timebase.source === 'default') rejectionReasons.push('uncalibrated_timebase');
  if (input?.settings.scaleSource === 'default' || output?.settings.scaleSource === 'default') rejectionReasons.push('uncalibrated_channel_scale');
  if ((input?.clippedCount ?? 0) > 5 || (output?.clippedCount ?? 0) > 5) rejectionReasons.push('clipped_channel');
  if (fit) {
    if (fit.contiguousCycles + 1e-9 < minCycles) rejectionReasons.push('insufficient_cycles');
    if (colsPerCycle < options.minColsPerCycle) rejectionReasons.push('insufficient_cols_per_cycle');
    if (cycles > 0 && !fit.nyquist) rejectionReasons.push('nyquist_limit');
    if (!fit.sufficientCoverage && cycles >= 1) rejectionReasons.push('insufficient_shared_coverage');
    if (vinPx < options.minPeakToPeakPx || voutPx < options.minPeakToPeakPx) rejectionReasons.push('insufficient_peak_to_peak_px');
    if (fit.sufficientCoverage && (r2In === null || r2Out === null || r2In < options.minR2 || r2Out < options.minR2)) {
      rejectionReasons.push('poor_sine_fit');
    }
    if (fit.sufficientCoverage && fit.contiguousCycles + 1e-9 >= minCycles && cycles < 3) warnings.push('fewer_than_3_cycles');
  }
  const phaseDeg = manualPhase ?? (rejectionReasons.length === 0 && fit?.input && fit.output
    ? wrapPhase(fit.output.phaseDeg - fit.input.phaseDeg) : null);
  const manualMeasurement = positive(edit?.vinVpp) || positive(edit?.voutVpp) || Number.isFinite(edit?.gainDb) || manualPhase !== null;
  if (rejectionReasons.length && inputChannel !== outputChannel && manualMeasurement
      && positive(frequencyHz) && Number.isFinite(gainDb) && !edit?.excluded) {
    warnings.push('manual_measurement');
    rejectionReasons.length = 0;
  }
  if (edit?.excluded) rejectionReasons.push('manually_excluded');

  return {
    id, fileName: extraction.fileName, frequencyHz, frequencySource, vinVpp, voutVpp, gainDb, phaseDeg, cycles, colsPerCycle, vinPx, voutPx,
    r2In, r2Out, accepted: rejectionReasons.length === 0 && Number.isFinite(gainDb), rejectionReasons, warnings,
    edited: Boolean(edit && Object.keys(edit).length), extraction,
  };
}

function summarize(points: BodePoint[], options: Required<BodeGateOptions>, elapsedMs: number): BodeResult {
  points.sort((a, b) => (a.frequencyHz ?? Infinity) - (b.frequencyHz ?? Infinity));
  const usable = (point: BodePoint): point is BodePoint & { frequencyHz: number; gainDb: number } =>
    point.accepted && positive(point.frequencyHz) && typeof point.gainDb === 'number' && Number.isFinite(point.gainDb);
  const accepted = points.filter(usable);
  let peak = 0;
  for (let i = 1; i < accepted.length; i++) if (accepted[i]!.gainDb > accepted[peak]!.gainDb) peak = i;
  const plateauFloor = (accepted[peak]?.gainDb ?? 0) - 0.2;
  let left = peak;
  let right = peak;
  while (left > 0 && accepted[left - 1]!.gainDb >= plateauFloor) left--;
  while (right + 1 < accepted.length && accepted[right + 1]!.gainDb >= plateauFloor) right++;
  const plateau = accepted.slice(left, right + 1);
  const passbandGainDb = plateau.length ? plateau.reduce((sum, point) => sum + point.gainDb / plateau.length, 0) : null;
  const cutoffTargetDb = passbandGainDb === null ? null : passbandGainDb - 3;
  function cutoff(start: BodePoint | undefined, step: -1 | 1): number | null {
    if (!start || cutoffTargetDb === null) return null;
    for (let i = points.indexOf(start); i + step >= 0 && i + step < points.length; i += step) {
      const inside = points[i]!;
      const outside = points[i + step]!;
      if (!usable(inside) || !usable(outside) || inside.frequencyHz === outside.frequencyHz
          || inside.gainDb < cutoffTargetDb || outside.gainDb > cutoffTargetDb || inside.gainDb === outside.gainDb) continue;
      const fraction = (cutoffTargetDb - inside.gainDb) / (outside.gainDb - inside.gainDb);
      return Math.exp(Math.log(inside.frequencyHz) + fraction * (Math.log(outside.frequencyHz) - Math.log(inside.frequencyHz)));
    }
    return null;
  }
  const cutoffLowHz = cutoff(plateau[0], -1);
  const cutoffHighHz = cutoff(plateau.at(-1), 1);
  return {
    inputChannel: options.inputChannel, outputChannel: options.outputChannel, points, passbandGainDb,
    cutoffHz: cutoffLowHz ?? cutoffHighHz, cutoffTargetDb, cutoffLowHz, cutoffHighHz,
    acceptedCount: accepted.length, rejectedCount: points.length - accepted.length, elapsedMs, gateOptions: options,
  };
}

export function analyzeBodeBatch(extractions: readonly ExtractionResult[], options: BodeGateOptions = {},
  overrides: BodeOverrides = {}): BodeResult {
  const start = performance.now();
  const normalized = gates(options);
  const used = new Set<string>();
  const points = extractions.map(extraction => {
    const name = extraction.fileName;
    let id = name;
    let suffix = 2;
    while (used.has(id)) id = `${name}#${suffix++}`;
    used.add(id);
    return evaluate(extraction, id, normalized, overrideFor(overrides, id), false);
  });
  return summarize(points, normalized, performance.now() - start);
}

export function recomputeBodeResult(result: BodeResult, overrides: BodeOverrides = {}, options: BodeGateOptions = {}): BodeResult {
  const start = performance.now();
  const normalized = gates({ inputChannel: result.inputChannel, outputChannel: result.outputChannel, ...result.gateOptions, ...options });
  const points = result.points.map(point => evaluate(point.extraction, point.id, normalized, overrideFor(overrides, point.id), true));
  return summarize(points, normalized, performance.now() - start);
}
