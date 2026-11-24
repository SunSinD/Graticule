import { fitShared, wrapPhase } from './dsp.js';
import { parseEngineering } from './export/format.js';
import { scopeFrequency } from './measurements.js';
import type { BodeGateOptions, BodePoint, BodePointOverride, BodeRejectedCapture, BodeResult, ExtractionResult } from './types.js';

export type BodeOverrides = Readonly<Record<string, BodePointOverride | undefined>> | ReadonlyMap<string, BodePointOverride>;

const defaults: Required<BodeGateOptions> = {
  inputChannel: 'C1', outputChannel: 'C2', minCycles: 1.5, minColsPerCycle: 12, minPeakToPeakPx: 12, minR2: 0.96,
  preferManualFrequency: false,
};

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function frequenciesDiffer(a: number | null | undefined, b: number | null | undefined): boolean {
  return positive(a) && positive(b) && Math.max(a, b) > 1.01 * Math.min(a, b);
}

function gainFromVpp(vinVpp: number | null, voutVpp: number | null): number | null {
  return positive(vinVpp) && positive(voutVpp) ? 20 * (Math.log10(voutVpp) - Math.log10(vinVpp)) : null;
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
    preferManualFrequency: options.preferManualFrequency ?? defaults.preferManualFrequency,
  };
}

export function frequencyFromFileName(name: string): number | null {
  const baseName = (name.split(/[/\\]/).at(-1) ?? '').replace(/(\S)\s+-\s+/g, '$1 ');
  const tokens = /(?:[\p{L}\p{N}_]-(?=[\d.,])|^|[^\d.,+\-\u2212])([+\-\u2212]?\s*(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+\-]?\d+)?\s*[pnuµμmkMG]?\s*[Hh][Zz])(?=$|[^A-Za-z])/gu;
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
  const outputWaveform = extraction.measurements.find(measurement => measurement.channel === outputChannel)?.frequencyHz;
  const mismatch = frequenciesDiffer(waveform, outputWaveform);
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
    : gainFromVpp(vinVpp, voutVpp);
  const manualPhase = typeof edit?.phaseDeg === 'number' && Number.isFinite(edit.phaseDeg) ? wrapPhase(edit.phaseDeg) : null;

  const rejectionReasons: string[] = [];
  const warnings: string[] = [];
  const minCycles = Math.max(1, options.minCycles);
  if (!input || !output || inputChannel === outputChannel) rejectionReasons.push('missing_channels');
  if (!frequencyHz) rejectionReasons.push('frequency_unconfirmed');
  if (mismatch) rejectionReasons.push('frequency_mismatch');
  if (extraction.timebase.source === 'default') rejectionReasons.push('uncalibrated_timebase');
  if (input?.settings.scaleSource === 'default' || output?.settings.scaleSource === 'default') rejectionReasons.push('uncalibrated_channel_scale');
  if ((input?.clippedCount ?? 0) > 5 || (output?.clippedCount ?? 0) > 5) rejectionReasons.push('clipped_channel');
  if (fit) {
    if (fit.contiguousCycles + 1e-9 < minCycles) rejectionReasons.push('insufficient_cycles');
    if (colsPerCycle < options.minColsPerCycle * (1 - 1e-9)) rejectionReasons.push('insufficient_cols_per_cycle');
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
  if (rejectionReasons.length && !mismatch && inputChannel !== outputChannel && manualMeasurement
      && positive(frequencyHz) && Number.isFinite(gainDb) && !edit?.excluded) {
    warnings.push('manual_measurement');
    rejectionReasons.length = 0;
  }
  if (edit?.excluded) rejectionReasons.push('manually_excluded');

  return {
    id, fileName: extraction.fileName, frequencyHz, frequencySource, vinVpp, voutVpp, gainDb, phaseDeg, cycles, colsPerCycle, vinPx, voutPx,
    r2In, r2Out, accepted: rejectionReasons.length === 0 && Number.isFinite(gainDb), rejectionReasons, warnings,
    edited: Boolean(edit && Object.keys(edit).length),
    ...(edit ? { override: { ...edit }, preferManualFrequency: live && positive(manual) } : {}), extraction,
  };
}

function rejectedPoint(capture: BodeRejectedCapture, id: string, options: Required<BodeGateOptions>, edit: BodePointOverride | undefined,
  live: boolean): BodePoint {
  const baseReason = capture.rejectionReason;
  const hint = frequencyFromFileName(capture.fileName);
  const manual = edit?.frequencyHz;
  const useManual = positive(manual) && (live || hint === null);
  const frequencyHz = useManual ? manual : hint;
  const vinVpp = positive(edit?.vinVpp) ? edit.vinVpp : null;
  const voutVpp = positive(edit?.voutVpp) ? edit.voutVpp : null;
  const gainDb = typeof edit?.gainDb === 'number' && Number.isFinite(edit.gainDb) ? edit.gainDb : gainFromVpp(vinVpp, voutVpp);
  const phaseDeg = typeof edit?.phaseDeg === 'number' && Number.isFinite(edit.phaseDeg) ? wrapPhase(edit.phaseDeg) : null;
  // A finite gain on an unreadable capture always comes from a manual measurement.
  const accepted = options.inputChannel !== options.outputChannel && positive(frequencyHz) && Number.isFinite(gainDb) && !edit?.excluded;
  const rejectionReasons = accepted ? [] : [baseReason];
  if (edit?.excluded) rejectionReasons.push('manually_excluded');
  return {
    id, fileName: capture.fileName, frequencyHz, frequencySource: useManual ? 'manual' : hint === null ? 'none' : 'filename',
    vinVpp, voutVpp, gainDb, phaseDeg, cycles: 0, colsPerCycle: 0, vinPx: 0, voutPx: 0,
    r2In: null, r2Out: null, accepted, rejectionReasons, warnings: accepted ? ['manual_measurement'] : [],
    edited: Boolean(edit && Object.keys(edit).length),
    ...(edit ? { override: { ...edit }, preferManualFrequency: live && positive(manual) } : {}),
    baseReason, extraction: null,
  };
}

function usable(point: BodePoint): point is BodePoint & { frequencyHz: number; gainDb: number } {
  return point.accepted && positive(point.frequencyHz) && point.gainDb !== null && Number.isFinite(point.gainDb);
}

interface BodeFrequency {
  readonly frequencyHz: number;
  readonly gainDb: number | null;
  readonly phaseDeg: number | null;
}

function meanPhase(phases: number[]): number | null {
  if (phases.length <= 1) return phases[0] ?? null;
  let x = 0;
  let y = 0;
  for (const phase of phases.sort((a, b) => a - b)) {
    const angle = phase * (Math.PI / 180);
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  return Math.hypot(x, y) > phases.length * 1e-12 ? wrapPhase(Math.atan2(y, x) * 180 / Math.PI) : null;
}

export function aggregateBodeFrequencies(points: readonly BodePoint[]): BodeFrequency[] {
  const groups = new Map<number, { gains: number[]; phases: number[] }>();
  for (const point of points) {
    if (!positive(point.frequencyHz)) continue;
    const group = groups.get(point.frequencyHz) ?? { gains: [], phases: [] };
    if (usable(point)) {
      group.gains.push(point.gainDb);
      if (point.phaseDeg !== null && Number.isFinite(point.phaseDeg)) group.phases.push(point.phaseDeg);
    }
    groups.set(point.frequencyHz, group);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([frequencyHz, { gains, phases }]) => ({
    frequencyHz,
    gainDb: gains.length ? gains.sort((a, b) => a - b).reduce((sum, gain) => sum + gain / gains.length, 0) : null,
    phaseDeg: meanPhase(phases),
  }));
}

function interpolateCutoff(inside: BodeFrequency, outside: BodeFrequency, target: number): number | null {
  if (inside.gainDb === null || outside.gainDb === null || inside.gainDb < target
      || outside.gainDb > target || inside.gainDb === outside.gainDb) return null;
  if (inside.gainDb === target) return inside.frequencyHz;
  if (outside.gainDb === target) return outside.frequencyHz;
  const fraction = (target / 2 - inside.gainDb / 2) / (outside.gainDb / 2 - inside.gainDb / 2);
  return Math.exp(Math.log(inside.frequencyHz) + fraction * (Math.log(outside.frequencyHz) - Math.log(inside.frequencyHz)));
}

function findNotch(frequencies: readonly BodeFrequency[], target: number): { low: number; high: number } | null {
  let low: number | null = null;
  for (let i = 1; i < frequencies.length; i++) {
    const previous = frequencies[i - 1]!;
    const current = frequencies[i]!;
    if (previous.gainDb === null || current.gainDb === null) {
      low = null;
    } else if (current.gainDb < target) {
      low ??= interpolateCutoff(previous, current, target);
    } else if (low !== null) {
      const high = interpolateCutoff(current, previous, target);
      if (high !== null) return { low, high };
      low = null;
    }
  }
  return null;
}

function summarize(points: BodePoint[], options: Required<BodeGateOptions>, elapsedMs: number): BodeResult {
  points.sort((a, b) => (a.frequencyHz ?? Infinity) - (b.frequencyHz ?? Infinity));
  const acceptedCount = points.filter(usable).length;
  const frequencies = aggregateBodeFrequencies(points);
  const accepted = frequencies.filter((point): point is BodeFrequency & { gainDb: number } => point.gainDb !== null);
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
  function cutoff(start: BodeFrequency | undefined, step: -1 | 1): number | null {
    if (!start || cutoffTargetDb === null) return null;
    for (let i = frequencies.indexOf(start); i + step >= 0 && i + step < frequencies.length; i += step) {
      const crossing = interpolateCutoff(frequencies[i]!, frequencies[i + step]!, cutoffTargetDb);
      if (crossing !== null) return crossing;
    }
    return null;
  }
  const first = accepted[0];
  const last = accepted.at(-1);
  const notch = cutoffTargetDb !== null && first && last && first.gainDb > cutoffTargetDb && last.gainDb > cutoffTargetDb
    ? findNotch(frequencies, cutoffTargetDb) : null;
  const cutoffLowHz = notch?.low ?? cutoff(plateau[0], -1);
  const cutoffHighHz = notch?.high ?? cutoff(plateau.at(-1), 1);
  return {
    inputChannel: options.inputChannel, outputChannel: options.outputChannel, points, passbandGainDb,
    cutoffHz: cutoffLowHz ?? cutoffHighHz, cutoffTargetDb, cutoffLowHz, cutoffHighHz,
    acceptedCount, rejectedCount: points.length - acceptedCount, elapsedMs, gateOptions: options,
  };
}

export function analyzeBodeBatch(extractions: readonly (ExtractionResult | BodeRejectedCapture)[], options: BodeGateOptions = {},
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
    const edit = overrideFor(overrides, id);
    return 'rejectionReason' in extraction ? rejectedPoint(extraction, id, normalized, edit, normalized.preferManualFrequency)
      : evaluate(extraction, id, normalized, edit, normalized.preferManualFrequency);
  });
  return summarize(points, normalized, performance.now() - start);
}

function isGateOptions(options: BodeGateOptions | BodeOverrides): options is BodeGateOptions {
  return !(options instanceof Map) && Object.entries(options).every(([key, value]) =>
    Object.hasOwn(defaults, key) && (value === undefined || typeof value === typeof defaults[key as keyof BodeGateOptions]));
}

export function recomputeBodeResult(result: BodeResult, options?: BodeGateOptions): BodeResult;
export function recomputeBodeResult(result: BodeResult, overrides: BodeOverrides | undefined, options?: BodeGateOptions): BodeResult;
export function recomputeBodeResult(result: BodeResult, edits?: BodeOverrides | BodeGateOptions, options?: BodeGateOptions): BodeResult {
  const gateOnly = options === undefined && edits !== undefined && isGateOptions(edits);
  const gateChanges = Object.fromEntries(Object.entries(gateOnly ? edits : options ?? {}).filter(([, value]) => value !== undefined));
  const normalized = gates({ inputChannel: result.inputChannel, outputChannel: result.outputChannel, ...result.gateOptions,
    ...gateChanges });
  const pairChanged = normalized.inputChannel !== result.inputChannel || normalized.outputChannel !== result.outputChannel;
  const liveEdits = edits && !gateOnly ? edits as BodeOverrides : undefined;
  const points = result.points.map(point => {
    let edit = liveEdits ? overrideFor(liveEdits, point.id) : point.override;
    if (pairChanged && edit) {
      const { frequencyHz, excluded } = edit;
      edit = frequencyHz === undefined && excluded === undefined ? undefined : {
        ...(frequencyHz !== undefined && { frequencyHz }),
        ...(excluded !== undefined && { excluded }),
      };
    }
    const live = Boolean(liveEdits || normalized.preferManualFrequency || point.preferManualFrequency);
    if (point.extraction) return evaluate(point.extraction, point.id, normalized, edit, live);
    const rejectionReason = point.baseReason ?? point.rejectionReasons.find(reason => reason !== 'manually_excluded') ?? 'capture_unreadable';
    return rejectedPoint({ fileName: point.fileName, rejectionReason }, point.id, normalized, edit, live);
  });
  return summarize(points, normalized, result.elapsedMs);
}
