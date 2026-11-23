import { columnInterval, columnSamples, isClipped, samplesFor } from './columns.js';
import { valid } from './dsp.js';
import { analysisPlot, axisValue, niceCeiling125 } from './export/analysis-plot.js';
import type { AnalysisPlotOptions } from './export/analysis-plot.js';
import { csvComment, csvField } from './export/csv.js';
import { csvNumber, formatEng, formatFixed, GRATICULE_VERSION } from './export/format.js';
import { renderTables } from './export/table.js';
import type { TableFormat } from './export/table.js';
import type { ExtractionResult, Locale, MathTraceResult, TraceSample, XyAxisId } from './types.js';

export type SpectrumWindow = 'hann' | 'rect' | 'flattop' | 'blackman';
export type ThdReason = 'clipped' | 'insufficient_cycles' | 'insufficient_resolution'
  | 'insufficient_swing' | 'insufficient_samples' | 'no_fundamental' | 'fit_failed';

export interface SpectrumOptions {
  readonly channel: XyAxisId;
  readonly window?: SpectrumWindow;
  readonly math?: MathTraceResult | null;
}

export interface SpectrumBin {
  readonly frequencyHz: number;
  readonly vrms: number;
  readonly dbv: number | null;
}

export interface SpectrumHarmonic extends SpectrumBin {
  readonly order: number;
  readonly dbc: number | null;
}

export interface SpectrumResult {
  readonly channel: XyAxisId;
  readonly unit: 'V' | 'V²';
  readonly window: SpectrumWindow;
  readonly dt: number;
  readonly sampleRateHz: number;
  readonly durationSec: number;
  readonly resolutionBandwidthHz: number | null;
  readonly binSpacingHz: number | null;
  readonly usedStartSec: number | null;
  readonly usedEndSec: number | null;
  readonly coverage: number;
  readonly interpolatedGaps: number;
  readonly interpolatedColumns: number;
  readonly clippedCount: number;
  readonly bins: readonly SpectrumBin[];
  readonly peaks: readonly SpectrumBin[];
  readonly fundamental: SpectrumBin | null;
  readonly noiseFloorDbc: number;
  readonly noiseFloorDbv: number | null;
  readonly thdPct: number | null;
  readonly thdBelowFloor: boolean;
  readonly thdReason: ThdReason | null;
  readonly harmonics: readonly SpectrumHarmonic[];
  readonly warnings: readonly string[];
}

export interface SpectrumSvgOptions extends AnalysisPlotOptions {
  readonly scale?: 'dbv' | 'linear';
}

type ObservedSample = TraceSample & { readonly voltage: number };
interface Span { readonly start: number; readonly end: number }

function longestSpan(samples: readonly TraceSample[]): Span | null {
  let best: Span | null = null;
  let bestHoles = Infinity;
  let start = 0;
  const inspect = (end: number) => {
    let balance = 0;
    const starts: { index: number; balance: number }[] = [];
    const ends: { index: number; balance: number }[] = [];
    // A usable interval has 20 * gap columns <= total columns. Keep only
    // record-high prefix balances, since a later equal one gives a shorter span.
    for (let i = start; i < end; i++) {
      if (valid(samples[i]!)) {
        if (!starts.length || balance > starts.at(-1)!.balance) starts.push({ index: i, balance });
        ends.push({ index: i, balance: --balance });
      } else balance += 19;
    }
    for (let j = ends.length - 1; j >= 0 && starts.length; j--) {
      const last = ends[j]!;
      while (starts.length && (starts.at(-1)!.index > last.index || starts.at(-1)!.balance >= last.balance)) {
        const first = starts.pop()!;
        const length = last.index - first.index + 1;
        const holes = (last.balance - first.balance + length) / 20;
        const bestLength = best ? best.end - best.start + 1 : 0;
        if (length > bestLength || (length > 0 && length === bestLength && (holes < bestHoles
            || (holes === bestHoles && first.index < best!.start)))) {
          best = { start: first.index, end: last.index };
          bestHoles = holes;
        }
      }
    }
  };
  for (let i = 0; i < samples.length;) {
    if (valid(samples[i]!)) {
      i++;
      continue;
    }
    const gap = i;
    while (i < samples.length && !valid(samples[i]!)) i++;
    if (i - gap > 3 || samples.slice(gap, i).some(s => s.status !== 'masked_cursor')) {
      inspect(gap);
      start = i;
    }
  }
  inspect(samples.length);
  return best;
}

const windowCoefficients: Readonly<Record<SpectrumWindow, readonly number[]>> = {
  rect: [1],
  hann: [0.5, -0.5],
  blackman: [0.42, -0.5, 0.08],
  flattop: [0.21557895, -0.41663158, 0.277263158, -0.083578947, 0.006947368],
};

const maxHarmonic = (sampleRate: number, hz: number) => Math.min(10, Math.floor(0.49 * sampleRate / hz));

function fft(real: Float64Array): Float64Array {
  const size = real.length, imag = new Float64Array(size);
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j]!, real[i]!];
  }
  for (let len = 2; len <= size; len *= 2) {
    const half = len / 2;
    for (let j = 0; j < half; j++) {
      const cos = Math.cos(-2 * Math.PI * j / len), sin = Math.sin(-2 * Math.PI * j / len);
      for (let a = j; a < size; a += len) {
        const b = a + half;
        const r = cos * real[b]! - sin * imag[b]!, i = sin * real[b]! + cos * imag[b]!;
        real[b] = real[a]! - r; imag[b] = imag[a]! - i;
        real[a] = real[a]! + r; imag[a] = imag[a]! + i;
      }
    }
  }
  return imag;
}

const db = (value: number): number | null => value > 0 && Number.isFinite(value) ? 20 * Math.log10(value) : null;

function isPeak(bin: SpectrumBin, index: number, bins: readonly SpectrumBin[]): boolean {
  return index > 0 && bin.vrms > 0 && Number.isFinite(bin.vrms) && bin.vrms >= bins[index - 1]!.vrms
    && (index === bins.length - 1 || bin.vrms > bins[index + 1]!.vrms);
}

interface Fit {
  readonly error: number;
  readonly amps: readonly number[];
}

function harmonicFit(samples: readonly ObservedSample[], scale: number, hz: number, count: number): Fit | null {
  const size = 2 * count + 1;
  if (!(hz > 0) || count < 1 || samples.length < size * 2) return null;
  const matrix = Array.from({ length: size }, () => new Float64Array(size + 1));
  const basis = new Float64Array(size);
  basis[0] = 1;
  const first = samples[0]!.timeSec, firstValue = samples[0]!.voltage;
  let energy = 0;
  for (const s of samples) {
    const angle = 2 * Math.PI * ((s.timeSec - first) * hz % 1);
    for (let h = 1; h <= count; h++) {
      basis[2 * h - 1] = Math.cos(h * angle);
      basis[2 * h] = Math.sin(h * angle);
    }
    const v = s.voltage - firstValue;
    energy += v * v;
    for (let i = 0; i < size; i++) {
      const row = matrix[i]!, u = basis[i]!;
      for (let j = i; j < size; j++) row[j] = row[j]! + u * basis[j]!;
      row[size] = row[size]! + u * v;
    }
  }
  const rhs = matrix.map(row => row[size]!);
  for (let i = 1; i < size; i++) for (let j = 0; j < i; j++) matrix[i]![j] = matrix[j]![i]!;
  for (let i = 0; i < size; i++) {
    let pivot = i;
    for (let j = i + 1; j < size; j++) if (Math.abs(matrix[j]![i]!) > Math.abs(matrix[pivot]![i]!)) pivot = j;
    [matrix[i], matrix[pivot]] = [matrix[pivot]!, matrix[i]!];
    const row = matrix[i]!, div = row[i]!;
    if (!Number.isFinite(div) || Math.abs(div) < 1e-10 * samples.length) return null;
    for (let j = i; j <= size; j++) row[j] = row[j]! / div;
    for (let k = 0; k < size; k++) {
      if (k === i) continue;
      const other = matrix[k]!, factor = other[i]!;
      for (let j = i; j <= size; j++) other[j] = other[j]! - factor * row[j]!;
    }
  }
  const beta = matrix.map(row => row[size]!);
  const error = Math.max(0, energy - beta.reduce((sum, b, i) => sum + b * rhs[i]!, 0));
  const amps = Array.from({ length: count }, (_, i) => Math.hypot(beta[2 * i + 1]!, beta[2 * i + 2]!) * (scale / Math.SQRT2));
  return { error, amps };
}

function refineFundamental(observed: readonly ObservedSample[], scale: number, sampleRate: number,
  peak: SpectrumBin, bandwidth: number, radius: number, single = false): SpectrumBin {
  const start = Math.max((single ? 0.35 : 2) * bandwidth, peak.frequencyHz - radius);
  const end = Math.min(sampleRate / 2, peak.frequencyHz + radius);
  if (end <= start) return peak;
  const count = single ? 1 : Math.max(1, maxHarmonic(sampleRate, end));
  const test = (hz: number) => ({ hz, fit: harmonicFit(observed, scale, hz, count) });
  const error = (trial: ReturnType<typeof test>) => trial.fit?.error ?? Infinity;
  const step = (end - start) / 12;
  let best = test(Math.max(start, peak.frequencyHz));
  for (let i = 0; i <= 12; i++) {
    const next = test(start + i * step);
    if (error(next) < error(best)) best = next;
  }
  let low = Math.max(start, best.hz - step), high = Math.min(end, best.hz + step);
  for (let i = 0; i < 21; i++) {
    const left = test(low + (high - low) / 3), right = test(high - (high - low) / 3);
    if (error(left) < error(right)) {
      high = right.hz;
      if (error(left) < error(best)) best = left;
    } else {
      low = left.hz;
      if (error(right) < error(best)) best = right;
    }
  }
  const vrms = best.fit?.amps[0];
  return vrms !== undefined && Number.isFinite(vrms) ? { frequencyHz: best.hz, vrms, dbv: db(vrms) } : peak;
}

function pixelStep(result: ExtractionResult, opts: SpectrumOptions): number {
  const pitch = result.detection.grid.pxPerVDiv;
  const trace = (id: XyAxisId) => result.traces.find(t => t.channel === id && t.settings.enabled);
  const delta = (id: XyAxisId) => (trace(id)?.settings.voltsPerDiv ?? 0) / pitch;
  const cfg = opts.math?.config;
  if (opts.channel !== 'M' || !cfg) return delta(opts.channel);
  const a = delta(cfg.a), b = delta(cfg.b);
  if (cfg.op !== 'mul') return Math.hypot(a, b);
  const peak = (id: XyAxisId) => trace(id)?.samples.reduce((m, s) => valid(s) ? Math.max(m, Math.abs(s.voltage)) : m, 0) ?? 0;
  return Math.hypot(peak(cfg.a) * b, peak(cfg.b) * a, a * b);
}

export function computeSpectrum(result: ExtractionResult, options: SpectrumOptions): SpectrumResult {
  const { channel, math } = options;
  const window = options.window ?? 'hann', unit = channel === 'M' ? math?.unit ?? 'V' : 'V';
  const dt = columnInterval(result), rate = 1 / dt;
  const sampleRateHz = Number.isFinite(rate) && rate > 0 ? rate : 0;
  const samples = columnSamples(result, samplesFor(result, channel, math));
  const clippedCount = samples.filter(s => isClipped(s.status)).length;
  const span = longestSpan(samples);
  const segment = span ? samples.slice(span.start, span.end + 1) : [];
  const observed = segment.filter(valid);
  const coverage = observed.length / samples.length;
  const interpolatedColumns = segment.length - observed.length;
  const interpolatedGaps = segment.filter((s, i) => !valid(s) && valid(segment[i - 1]!)).length;
  const durationSec = segment.length * dt;
  const noiseFloorDbc = -50;
  const sourceScale = channel === 'M' ? math?.voltsPerDiv
    : result.traces.find(t => t.channel === channel && t.settings.enabled)?.settings.voltsPerDiv;
  const fullScaleRms = (sourceScale ?? 0) * (result.detection.grid.vDivs / (2 * Math.SQRT2));
  const baseFloor = db(fullScaleRms);
  const warnings: string[] = [];
  if (!observed.length) warnings.push('no_usable_samples');
  else if (segment.length < samples.length) warnings.push('partial_capture');
  if (interpolatedGaps) warnings.push('interpolated_cursor_gaps');
  if (clippedCount) warnings.push('clipped');
  if (!sampleRateHz) warnings.push('invalid_sample_rate');
  if (result.timebase.source === 'default') warnings.push('uncalibrated_timebase');
  const base = {
    channel, unit, window, dt, sampleRateHz, durationSec, usedStartSec: segment[0]?.timeSec ?? null,
    usedEndSec: segment.at(-1)?.timeSec ?? null, coverage, interpolatedColumns, interpolatedGaps, clippedCount,
    noiseFloorDbc, warnings,
  } as const;
  if (observed.length < 8 || !sampleRateHz) return {
    ...base, bins: [], peaks: [], fundamental: null, resolutionBandwidthHz: null, binSpacingHz: null,
    noiseFloorDbv: baseFloor === null ? null : baseFloor + noiseFloorDbc,
    harmonics: [], thdBelowFloor: false, thdPct: null, thdReason: clippedCount ? 'clipped' : 'insufficient_samples',
  };
  const { min, max } = observed.reduce((acc, s) => ({
    min: Math.min(acc.min, s.voltage), max: Math.max(acc.max, s.voltage),
  }), { min: Infinity, max: -Infinity });
  const center = min / 2 + max / 2;
  const scale = Math.max(max - center, center - min) || 1;
  const normalized = (voltage: number) => (voltage - center) / scale;
  const centered = observed.map(s => ({ ...s, voltage: normalized(s.voltage) }));
  const fftSize = 2 ** Math.ceil(Math.log2(segment.length * 2));
  const real = new Float64Array(fftSize);
  const taper = new Float64Array(segment.length);
  const coefficients = windowCoefficients[window];
  let weightedSum = 0, weights = 0, prev = 0, next = 0;
  for (const [i, s] of segment.entries()) {
    if (valid(s)) {
      prev = i;
      next = i + 1;
      while (next < segment.length && !valid(segment[next]!)) next++;
    }
    const frac = next > prev ? (i - prev) / (next - prev) : 0;
    const v = valid(s) ? normalized(s.voltage)
      : (1 - frac) * normalized(segment[prev]!.voltage!) + frac * normalized(segment[next]!.voltage!);
    const angle = 2 * Math.PI * i / segment.length;
    const w = coefficients.reduce((sum, coefficient, order) => sum + coefficient * Math.cos(order * angle), 0);
    real[i] = v;
    taper[i] = w;
    weightedSum += v * w;
    weights += w;
  }
  const mean = weightedSum / weights;
  for (let i = 0; i < segment.length; i++) real[i] = (real[i]! - mean) * taper[i]!;
  const imag = fft(real), nyquist = fftSize / 2;
  const binSpacingHz = sampleRateHz / fftSize;
  const resolutionBandwidthHz = sampleRateHz / segment.length;
  const windowBin = (order: number) => segment.length / 2
    * ((coefficients[order] ?? 0) + (coefficients[segment.length - order] ?? 0));
  const bins = Array.from({ length: nyquist + 1 }, (_, i): SpectrumBin => {
    if (i === 0) return { frequencyHz: 0, vrms: 0, dbv: null };
    const interior = i < nyquist;
    const order = i * segment.length / fftSize;
    // At a coherent bin, correct both the mirrored line and the part of the
    // cosine removed by subtracting the weighted mean.
    const coherent = Number.isInteger(order);
    const image = interior && coherent ? windowBin(2 * order) : 0;
    const dcLeakage = coherent ? (interior ? 2 : 1) * windowBin(order) ** 2 / weights : 0;
    const vrms = Math.hypot(real[i]! / (weights + image - dcLeakage), imag[i]! / (weights - image))
      * (interior ? Math.SQRT2 : 1) * scale;
    return { frequencyHz: i * binSpacingHz, vrms, dbv: db(vrms) };
  });
  const peaks = bins.filter((b, i) => b.vrms > scale * 1e-10 && isPeak(b, i, bins)).sort((a, b) => b.vrms - a.vrms);
  const strongest = peaks[0];
  const refine = (peak: SpectrumBin, radius: number, single = false) => peak.frequencyHz >= sampleRateHz / 2 ? peak
    : refineFundamental(centered, scale, sampleRateHz, peak, resolutionBandwidthHz, radius * resolutionBandwidthHz, single);
  // A flat-top window can shift the apparent peak by more than one resolution bin.
  const detected = strongest && coverage >= 0.25 ? refine(strongest, window === 'flattop' ? 2.25 : 1.25, true) : null;
  let fundamental = detected && detected.frequencyHz / resolutionBandwidthHz >= 2 ? refine(detected, 0.35) : null;
  const quantization = pixelStep(result, options);
  if (detected && fundamental) {
    for (let order = 6; order >= 2; order--) {
      const frequencyHz = detected.frequencyHz / order;
      if (frequencyHz < 2 * resolutionBandwidthHz) continue;
      const count = maxHarmonic(sampleRateHz, frequencyHz);
      if (count < order) continue;
      // Fit the two lines together so leakage from the dominant harmonic
      // cannot pass for energy at its subharmonic.
      const fit = harmonicFit(centered, scale, frequencyHz, count);
      if (!fit) continue;
      const dominantRms = fit.amps[order - 1]!;
      const vrms = fit.amps[0]!;
      const residual = scale * Math.sqrt(fit.error / centered.length);
      const lineFloor = 5 * Math.max(residual, quantization / Math.sqrt(12)) / Math.sqrt(centered.length);
      const minimum = Math.max(lineFloor, dominantRms * 10 ** (noiseFloorDbc / 20));
      if (dominantRms >= 0.5 * detected.vrms && vrms >= minimum) {
        const candidate = refine({ frequencyHz, vrms, dbv: db(vrms) }, 0.45 / order);
        if (candidate.vrms >= minimum) {
          fundamental = candidate;
          break;
        }
      }
    }
  }
  const referenceDbv = fundamental?.dbv ?? baseFloor;
  const noiseFloorDbv = referenceDbv === null ? null : referenceDbv + noiseFloorDbc;
  const hz = fundamental?.frequencyHz ?? 0;
  const resTolerance = 1e-4;
  let thdReason: ThdReason | null = clippedCount ? 'clipped' : coverage < 0.25 ? 'insufficient_samples'
    : !fundamental ? strongest ? 'insufficient_cycles' : 'no_fundamental'
    : hz / resolutionBandwidthHz < 3 - 1e-2 ? 'insufficient_cycles'
      : sampleRateHz / hz < 16 - resTolerance ? 'insufficient_resolution'
        : (max / 2 - min / 2) < 20 * quantization ? 'insufficient_swing' : null;
  const fit = thdReason === null ? harmonicFit(centered, scale, hz, maxHarmonic(sampleRateHz, hz)) : null;
  const firstRms = fit?.amps[0] ?? 0;
  if (!thdReason && !(firstRms > 0)) thdReason = 'fit_failed';
  const harmonics = firstRms > 0 ? fit!.amps.slice(0, 5).map((vrms, index): SpectrumHarmonic => ({
    order: index + 1, frequencyHz: (index + 1) * hz, vrms, dbv: db(vrms), dbc: db(vrms / firstRms),
  })) : [];
  const thdPct = thdReason === null ? 100 * Math.hypot(...fit!.amps.slice(1).map(vrms => vrms / firstRms)) : null;
  return {
    ...base, bins, peaks: peaks.slice(0, 8), fundamental, resolutionBandwidthHz, binSpacingHz, noiseFloorDbv,
    harmonics, thdBelowFloor: thdPct !== null && thdPct < 0.5, thdPct, thdReason,
  };
}

export function renderSpectrumSvg(spec: SpectrumResult, opts: SpectrumSvgOptions = {}): string {
  const linear = opts.scale === 'linear', locale = opts.locale ?? 'en';
  const nyquist = spec.bins.at(-1)?.frequencyHz || 1;
  const maxHarmonicHz = spec.harmonics.reduce((max, h) => Math.max(max, h.frequencyHz), 0);
  let maxHz = nyquist;
  if (spec.fundamental) {
    const harmonicLimit = Math.max(12 * spec.fundamental.frequencyHz, maxHarmonicHz * 1.35);
    const significantRms = 0.01 * spec.fundamental.vrms; // -40 dBc
    let upperHz = harmonicLimit;
    for (let i = spec.bins.length - 1; i > 0; i--) {
      const bin = spec.bins[i]!;
      if (bin.frequencyHz <= harmonicLimit) break;
      if (bin.vrms >= significantRms && isPeak(bin, i, spec.bins)) {
        upperHz = bin.frequencyHz;
        break;
      }
    }
    maxHz = Math.min(nyquist, niceCeiling125(upperHz));
  }
  const hzStep = niceCeiling125(maxHz / 6 || Number.MIN_VALUE);
  const xTicks = Array.from({ length: Math.floor(maxHz / hzStep + 1e-9) + 1 }, (_, i) => ({
    fraction: Math.min(1, i * hzStep / maxHz), label: axisValue(i * hzStep, 'Hz', locale),
  }));
  const floor = spec.noiseFloorDbv;
  const low = floor === null ? -100 : floor - 12;
  const maxDb = spec.bins.reduce((m, b) => Math.max(m, b.dbv ?? m), low + 7) + 3;
  const step = [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find(step =>
    Math.ceil(maxDb / step) - Math.floor(low / step) <= 8) ?? 2000;
  const min = linear ? 0 : Math.ceil(maxDb / step) * step - 8 * step;
  const amp = (bin: SpectrumBin) => linear ? Math.min(Number.MAX_VALUE, bin.vrms) : bin.dbv ?? min;
  const maxAmp = spec.bins.reduce((m, b) => Math.max(m, amp(b)), min);
  const max = linear ? Math.min(Number.MAX_VALUE, maxAmp * 1.08) || 1 : min + 8 * step;
  const label = linear ? `${spec.unit} RMS` : spec.unit === 'V²' ? 'dB re 1 V²' : 'dBV';
  const fraction = (value: number) => (value - min) / (max - min);
  const yTicks = Array.from({ length: 9 }, (_, i) => {
    const f = i / 8, value = min + f * (max - min);
    return { fraction: f, label: linear ? axisValue(value, spec.unit, locale) : formatFixed(value, 0, locale) };
  });
  return analysisPlot(opts, opts.title ?? `FFT ${spec.channel}`, false, locale === 'fr' ? 'Fréquence (Hz)' : 'Frequency (Hz)', label,
    xTicks, yTicks, (x, y, ink) => {
      const firstOutside = spec.bins.findIndex(b => b.frequencyHz > maxHz);
      const visibleBins = firstOutside < 0 ? spec.bins : spec.bins.slice(0, firstOutside + 1);
      const bins = visibleBins.map(b => `${x(b.frequencyHz / maxHz)},${y(Math.min(1, Math.max(0, fraction(amp(b)))))}`);
      const floorY = floor === null ? null : y(fraction(linear ? 10 ** (floor / 20) : floor));
      const labels: { x: number; y: number }[] = [];
      const harmonics = spec.harmonics.length ? spec.harmonics : spec.fundamental ? [{ ...spec.fundamental, order: 1 }] : [];
      const markers = harmonics.filter(h => h.frequencyHz <= maxHz)
        .map(h => {
          const px = x(h.frequencyHz / maxHz), py = y(Math.min(0.96, Math.max(0.04, fraction(amp(h)))));
          const labelX = Math.min(px + 4, x(1) - 18);
          let labelY = Math.max(y(1) + 11, py - 5);
          const offset = labelY > y(0.5) ? -13 : 13;
          while (labels.some(prior => Math.abs(prior.x - labelX) < 20 && Math.abs(prior.y - labelY) < 12)) labelY += offset;
          labels.push({ x: labelX, y: labelY });
          return `<circle cx="${px}" cy="${py}" r="2.5" fill="${ink}"/><text x="${labelX}" y="${labelY}" fill="${ink}" font-family="system-ui,sans-serif" font-size="10">H${h.order}</text>`;
        }).join('');
      return `<g clip-path="url(#analysis-plot-clip)">`
        + (bins.length ? `<polyline points="${bins.join(' ')}" fill="none" stroke="${ink}" stroke-width="1.1"/>` : '')
        + (floorY === null ? '' : `<path aria-label="${locale === 'fr' ? 'Plancher de quantification' : 'Quantization floor'}" d="M${x(0)} ${floorY}H${x(1)}" stroke="${ink}" stroke-dasharray="4 3"/>`)
        + markers + '</g>';
    });
}

export function renderSpectrumCsv(spec: SpectrumResult, title?: string): string {
  const squared = spec.unit === 'V²';
  const rmsColumn = squared ? 'v2_rms' : 'vrms';
  const dbColumn = squared ? 'db_re_1v2' : 'dbv';
  return [
    `# Graticule v${GRATICULE_VERSION}`,
    ...(title?.trim() ? [`# title: ${csvComment(title)}`] : []),
    `# channel: ${spec.channel} (${spec.unit}), window=${spec.window}`,
    `# sample_rate_hz: ${csvNumber(spec.sampleRateHz)}, resolution_bandwidth_hz=${csvNumber(spec.resolutionBandwidthHz)}`,
    `# used_start_s: ${csvNumber(spec.usedStartSec)}, used_end_s=${csvNumber(spec.usedEndSec)}, coverage=${csvNumber(spec.coverage)}, interpolated_gaps=${spec.interpolatedGaps}`,
    `# noise_floor_${dbColumn}: ${csvNumber(spec.noiseFloorDbv)}, thd_pct=${csvNumber(spec.thdPct)}, thd_below_floor=${spec.thdBelowFloor}, thd_reason=${spec.thdReason ?? ''}`,
    `# warnings: ${csvField(spec.warnings.join(' | '))}`,
    ...spec.harmonics.map(h => `# H${h.order}: frequency_hz=${csvNumber(h.frequencyHz)}, ${rmsColumn}=${csvNumber(h.vrms)}, dbc=${csvNumber(h.dbc)}`),
    `frequency_hz,${rmsColumn},${dbColumn}`,
    ...spec.bins.map(b => [csvNumber(b.frequencyHz), csvNumber(b.vrms), csvNumber(b.dbv)].join(',')),
  ].join('\n') + '\n';
}

const thdLabels: Readonly<Record<ThdReason, Readonly<Record<Locale, string>>>> = {
  clipped: { en: 'clipped signal', fr: 'signal écrêté' },
  insufficient_cycles: { en: 'too few cycles', fr: 'trop peu de cycles' },
  insufficient_resolution: { en: 'too few points per cycle', fr: 'trop peu de points par cycle' },
  insufficient_swing: { en: 'signal too small', fr: 'signal trop faible' },
  insufficient_samples: { en: 'too few samples', fr: 'trop peu d’échantillons' },
  no_fundamental: { en: 'no fundamental found', fr: 'aucune fondamentale' },
  fit_failed: { en: 'could not fit the signal', fr: 'ajustement impossible' },
};

export function renderSpectrumTable(spec: SpectrumResult, locale: Locale, format: TableFormat, title?: string): string {
  const fr = locale === 'fr';
  const rms = (v: number | null) => v === null ? '—' : axisValue(v, spec.unit, locale);
  return renderTables([{
    caption: title?.trim() || `FFT ${spec.channel}`,
    head: [fr ? 'Mesure' : 'Measurement', fr ? 'Valeur' : 'Value'], numericFrom: 1,
    rows: [
      [fr ? 'Fondamentale' : 'Fundamental', formatEng(spec.fundamental?.frequencyHz, 'Hz', locale, { sig: 4 })],
      [fr ? 'Amplitude efficace' : 'RMS amplitude', rms(spec.fundamental?.vrms ?? null)],
      [fr ? 'Résolution spectrale' : 'Resolution bandwidth', spec.resolutionBandwidthHz ? axisValue(spec.resolutionBandwidthHz, 'Hz', locale) : '—'],
      ['THD', spec.thdPct === null ? (spec.thdReason ? thdLabels[spec.thdReason][locale] : '—')
        : spec.thdBelowFloor ? (fr ? '< 0,5%' : '< 0.5%') : `${formatFixed(spec.thdPct, 2, locale)}%`],
    ],
  }, ...(spec.harmonics.length ? [{
    caption: fr ? 'Harmoniques' : 'Harmonics', head: ['H', 'Hz', `${spec.unit} RMS`, 'dBc'], numericFrom: 1,
    rows: spec.harmonics.map(h => [`H${h.order}`, axisValue(h.frequencyHz, 'Hz', locale), rms(h.vrms), formatFixed(h.dbc, 2, locale)]),
  }] : [])], format);
}
