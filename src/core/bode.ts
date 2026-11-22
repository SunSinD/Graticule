import { fitShared, wrapPhase } from './dsp.js';
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
  return {
    inputChannel: options.inputChannel ?? defaults.inputChannel,
    outputChannel: options.outputChannel ?? defaults.outputChannel,
    minCycles: positive(options.minCycles) ? options.minCycles : defaults.minCycles,
    minColsPerCycle: positive(options.minColsPerCycle) ? options.minColsPerCycle : defaults.minColsPerCycle,
    minPeakToPeakPx: positive(options.minPeakToPeakPx) ? options.minPeakToPeakPx : defaults.minPeakToPeakPx,
    minR2: positive(options.minR2) && options.minR2 <= 1 ? options.minR2 : defaults.minR2,
  };
}

export function frequencyFromFileName(name: string): number | null {
  const match = /(?:^|[^\d.,])([\d]+(?:[.,]\d+)?)\s*([kM]?)\s*Hz(?=$|[^a-z])/i.exec(name);
  if (!match) return null;
  const prefix = match[2] ?? '';
  const frequency = Number(match[1]!.replace(',', '.')) * (prefix.toLowerCase() === 'k' ? 1e3 : prefix ? 1e6 : 1);
  return positive(frequency) ? frequency : null;
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
  const phaseDeg = typeof edit?.phaseDeg === 'number' && Number.isFinite(edit.phaseDeg) ? wrapPhase(edit.phaseDeg)
    : fit?.input && fit.output ? wrapPhase(fit.output.phaseDeg - fit.input.phaseDeg) : null;

  const rejectionReasons: string[] = [];
  const warnings: string[] = [];
  if (!input || !output || inputChannel === outputChannel) rejectionReasons.push('missing_channels');
  if (!frequencyHz) rejectionReasons.push('frequency_unconfirmed');
  if (extraction.timebase.source === 'default') rejectionReasons.push('uncalibrated_timebase');
  if (input?.settings.scaleSource === 'default' || output?.settings.scaleSource === 'default') rejectionReasons.push('uncalibrated_channel_scale');
  if ((input?.clippedCount ?? 0) > 5 || (output?.clippedCount ?? 0) > 5) rejectionReasons.push('clipped_channel');
  if (fit) {
    if (cycles < options.minCycles) rejectionReasons.push('insufficient_cycles');
    if (colsPerCycle < options.minColsPerCycle) rejectionReasons.push('insufficient_cols_per_cycle');
    if (vinPx < options.minPeakToPeakPx || voutPx < options.minPeakToPeakPx) rejectionReasons.push('insufficient_peak_to_peak_px');
    if (r2In === null || r2Out === null || r2In < options.minR2 || r2Out < options.minR2) rejectionReasons.push('poor_sine_fit');
    if (cycles >= options.minCycles && cycles < 3) warnings.push('fewer_than_3_cycles');
  }
  if (edit?.excluded) rejectionReasons.push('manually_excluded');

  return {
    id, fileName: extraction.fileName, frequencyHz, frequencySource, vinVpp, voutVpp, gainDb, phaseDeg, cycles, colsPerCycle, vinPx, voutPx,
    r2In, r2Out, accepted: rejectionReasons.length === 0 && gainDb !== null, rejectionReasons, warnings,
    edited: Boolean(edit && Object.keys(edit).length), extraction,
  };
}

function summarize(points: BodePoint[], options: Required<BodeGateOptions>, elapsedMs: number): BodeResult {
  points.sort((a, b) => (a.frequencyHz ?? Infinity) - (b.frequencyHz ?? Infinity));
  const accepted = points.filter(point => point.accepted && point.gainDb !== null && point.frequencyHz !== null);
  const firstFrequency = accepted[0]?.frequencyHz;
  const lowest = firstFrequency === null || firstFrequency === undefined
    ? [] : accepted.filter(point => point.frequencyHz! <= 2 * firstFrequency);
  const passbandGainDb = lowest.length ? lowest.reduce((sum, point) => sum + point.gainDb!, 0) / lowest.length : null;
  const cutoffTargetDb = passbandGainDb === null ? null : passbandGainDb - 3;
  let cutoffHz: number | null = null;
  if (cutoffTargetDb !== null) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (!a.accepted || !b.accepted || a.frequencyHz === null || b.frequencyHz === null || a.gainDb === null || b.gainDb === null
          || a.frequencyHz >= b.frequencyHz || a.gainDb < cutoffTargetDb || b.gainDb > cutoffTargetDb || a.gainDb === b.gainDb) continue;
      const fraction = (cutoffTargetDb - a.gainDb) / (b.gainDb - a.gainDb);
      cutoffHz = Math.exp(Math.log(a.frequencyHz) + fraction * Math.log(b.frequencyHz / a.frequencyHz));
      break;
    }
  }
  return {
    inputChannel: options.inputChannel, outputChannel: options.outputChannel, points, passbandGainDb, cutoffHz, cutoffTargetDb,
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
