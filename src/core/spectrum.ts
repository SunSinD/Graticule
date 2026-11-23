import { columnInterval, columnSamples, isClipped, samplesFor } from './columns.js';
import { valid } from './dsp.js';
import { analysisPlot, axisValue } from './export/analysis-plot.js';
import type { AnalysisPlotOptions } from './export/analysis-plot.js';
import { csvField } from './export/csv.js';
import { csvNumber, formatFixed, GRATICULE_VERSION } from './export/format.js';
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

const maxHarmonic = (sampleRate: number, hz: number) => Math.min(10, Math.floor(0.4 * sampleRate / hz));

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
  const first = samples[0]!.timeSec, firstValue = samples[0]!.voltage / scale;
  let energy = 0;
  for (const s of samples) {
    const angle = 2 * Math.PI * ((s.timeSec - first) * hz % 1);
    for (let h = 1; h <= count; h++) {
      basis[2 * h - 1] = Math.cos(h * angle);
      basis[2 * h] = Math.sin(h * angle);
    }
    const v = s.voltage / scale - firstValue;
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
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const fftSize = 2 ** Math.ceil(Math.log2(segment.length * 2));
  const real = new Float64Array(fftSize);
  const coefficients = windowCoefficients[window];
  const mean = observed.reduce((sum, s) => sum + s.voltage / scale, 0) / observed.length;
  let weights = 0, prev = 0, next = 0;
  for (const [i, s] of segment.entries()) {
    if (valid(s)) {
      prev = i;
      next = i + 1;
      while (next < segment.length && !valid(segment[next]!)) next++;
    }
    const frac = next > prev ? (i - prev) / (next - prev) : 0;
    const v = valid(s) ? s.voltage / scale
      : (1 - frac) * (segment[prev]!.voltage! / scale) + frac * (segment[next]!.voltage! / scale);
    const angle = 2 * Math.PI * i / segment.length;
    const w = coefficients.reduce((sum, coefficient, order) => sum + coefficient * Math.cos(order * angle), 0);
    real[i] = (v - mean) * w;
    weights += w;
  }
  const imag = fft(real), nyquist = fftSize / 2;
  const binSpacingHz = sampleRateHz / fftSize;
  const resolutionBandwidthHz = sampleRateHz / segment.length;
  const bins = Array.from({ length: nyquist + 1 }, (_, i): SpectrumBin => {
    const interior = i > 0 && i < nyquist;
    const order = i * segment.length / fftSize;
    // At a coherent bin the window can mix the negative-frequency image into
    // the positive one. Its contribution has opposite signs for cosine and sine.
    const image = interior && Number.isInteger(order)
      ? segment.length / 2 * ((coefficients[2 * order] ?? 0) + (coefficients[segment.length - 2 * order] ?? 0))
      : 0;
    const vrms = Math.hypot(real[i]! / (weights + image), imag[i]! / (weights - image)) * (interior ? Math.SQRT2 : 1) * scale;
    return { frequencyHz: i * binSpacingHz, vrms, dbv: db(vrms) };
  });
  const peaks = bins.filter((b, i) => i > 0 && b.vrms > scale * 1e-10 && b.vrms >= bins[i - 1]!.vrms
    && (i === nyquist || b.vrms > bins[i + 1]!.vrms)).sort((a, b) => b.vrms - a.vrms);
  const strongest = peaks[0];
  const harmonicOf = (ratio: number, frequencyHz: number) => Math.round(ratio) >= 2 && Math.round(ratio) <= 5
    && Math.abs(ratio - Math.round(ratio)) * frequencyHz <= resolutionBandwidthHz * 0.6;
  const refine = (peak: SpectrumBin, radius: number, single = false) => peak.frequencyHz >= sampleRateHz / 2 ? peak
    : refineFundamental(observed, scale, sampleRateHz, peak, resolutionBandwidthHz, radius * resolutionBandwidthHz, single);
  // Locate the dominant line with a single sinusoid before using harmonics to
  // refine it. This prevents the fit from relabeling it as its own harmonic.
  const detected = strongest && coverage >= 0.25 ? refine(strongest, 1.25, true) : null;
  let fundamental = detected && detected.frequencyHz / resolutionBandwidthHz >= 2 ? refine(detected, 0.35) : null;
  if (strongest && fundamental) {
    const dominant = fundamental;
    const candidates = peaks.filter(p => p.frequencyHz >= 2 * resolutionBandwidthHz && p.vrms >= 0.12 * strongest.vrms
      && harmonicOf(dominant.frequencyHz / p.frequencyHz, p.frequencyHz)).sort((a, b) => a.frequencyHz - b.frequencyHz);
    for (const p of candidates) {
      const candidate = refine(p, 0.85);
      // A window sidelobe can fall at an integer subharmonic. A real tone
      // must still have energy there after the stronger harmonic is fitted.
      if (candidate.vrms >= 0.1 * dominant.vrms && harmonicOf(dominant.frequencyHz / candidate.frequencyHz, candidate.frequencyHz)) {
        fundamental = candidate;
        break;
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
        : (max / 2 - min / 2) < 20 * pixelStep(result, options) ? 'insufficient_swing' : null;
  const fit = thdReason === null ? harmonicFit(observed, scale, hz, maxHarmonic(sampleRateHz, hz)) : null;
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
  const maxHz = spec.bins.at(-1)?.frequencyHz || 1;
  const floor = spec.noiseFloorDbv;
  const min = linear ? 0 : floor === null ? -100 : Math.floor((floor - 12) / 10) * 10;
  const amp = (bin: SpectrumBin) => linear ? bin.vrms : bin.dbv ?? min;
  const maxAmp = spec.bins.reduce((m, b) => Math.max(m, amp(b)), min);
  const max = linear ? maxAmp * 1.08 || 1 : Math.max(min + 10, Math.ceil((maxAmp + 3) / 10) * 10);
  const label = linear ? `${spec.unit} RMS` : spec.unit === 'V²' ? 'dB re 1 V²' : 'dBV';
  const fraction = (value: number) => (value - min) / (max - min);
  return analysisPlot(opts, opts.title ?? `FFT ${spec.channel}`, false, locale === 'fr' ? 'Fréquence (Hz)' : 'Frequency (Hz)', label,
    f => axisValue(maxHz * f, 'Hz', locale),
    f => linear ? axisValue(min + f * (max - min), spec.unit, locale) : formatFixed(min + f * (max - min), 0, locale),
    (x, y, ink) => {
      const bins = spec.bins.map(b => `${x(b.frequencyHz / maxHz)},${y(Math.min(1, Math.max(0, fraction(amp(b)))))}`);
      const floorY = floor === null ? null : y(fraction(linear ? 10 ** (floor / 20) : floor));
      const markers = (spec.harmonics.length ? spec.harmonics : spec.fundamental && [{ ...spec.fundamental, order: 1 }] || [])
        .map(h => {
          const px = x(h.frequencyHz / maxHz), py = y(Math.min(0.96, Math.max(0.04, fraction(amp(h)))));
          return `<circle cx="${px}" cy="${py}" r="2.5" fill="${ink}"/><text x="${px + 4}" y="${py - 5}" fill="${ink}" font-family="system-ui,sans-serif" font-size="10">H${h.order}</text>`;
        }).join('');
      return `<g clip-path="url(#analysis-plot-clip)">`
        + (bins.length ? `<polyline points="${bins.join(' ')}" fill="none" stroke="${ink}" stroke-width="1.1"/>` : '')
        + (floorY === null ? '' : `<path aria-label="${locale === 'fr' ? 'Plancher de quantification' : 'Quantization floor'}" d="M${x(0)} ${floorY}H${x(1)}" stroke="${ink}" stroke-dasharray="4 3"/>`)
        + markers + '</g>';
    });
}

export function renderSpectrumCsv(spec: SpectrumResult, title?: string): string {
  return [
    `# Graticule v${GRATICULE_VERSION}`,
    ...(title?.trim() ? [`# title: ${title.trim().replace(/[\r\n]+/g, ' ')}`] : []),
    `# channel: ${spec.channel} (${spec.unit}), window=${spec.window}`,
    `# sample_rate_hz: ${csvNumber(spec.sampleRateHz)}, resolution_bandwidth_hz=${csvNumber(spec.resolutionBandwidthHz)}`,
    `# used_start_s: ${csvNumber(spec.usedStartSec)}, used_end_s=${csvNumber(spec.usedEndSec)}, coverage=${csvNumber(spec.coverage)}, interpolated_gaps=${spec.interpolatedGaps}`,
    `# noise_floor_dbv: ${csvNumber(spec.noiseFloorDbv)}, thd_pct=${csvNumber(spec.thdPct)}, thd_below_floor=${spec.thdBelowFloor}, thd_reason=${spec.thdReason ?? ''}`,
    `# warnings: ${csvField(spec.warnings.join(' | '))}`,
    ...spec.harmonics.map(h => `# H${h.order}: frequency_hz=${csvNumber(h.frequencyHz)}, vrms=${csvNumber(h.vrms)}, dbc=${csvNumber(h.dbc)}`),
    'frequency_hz,vrms,dbv',
    ...spec.bins.map(b => [csvNumber(b.frequencyHz), csvNumber(b.vrms), csvNumber(b.dbv)].join(',')),
  ].join('\n') + '\n';
}

export function renderSpectrumTable(spec: SpectrumResult, locale: Locale, format: TableFormat, title?: string): string {
  const fr = locale === 'fr';
  const rms = (v: number | null) => v === null ? '—' : axisValue(v, spec.unit, locale);
  return renderTables([{
    caption: title?.trim() || `FFT ${spec.channel}`,
    head: [fr ? 'Mesure' : 'Measurement', fr ? 'Valeur' : 'Value'], numericFrom: 1,
    rows: [
      [fr ? 'Fondamentale' : 'Fundamental', spec.fundamental ? axisValue(spec.fundamental.frequencyHz, 'Hz', locale) : '—'],
      [fr ? 'Amplitude efficace' : 'RMS amplitude', rms(spec.fundamental?.vrms ?? null)],
      [fr ? 'Résolution spectrale' : 'Resolution bandwidth', spec.resolutionBandwidthHz ? axisValue(spec.resolutionBandwidthHz, 'Hz', locale) : '—'],
      ['THD', spec.thdPct === null ? spec.thdReason ?? '—' : spec.thdBelowFloor ? (fr ? '< 0,5%' : '< 0.5%') : `${formatFixed(spec.thdPct, 2, locale)}%`],
    ],
  }, ...(spec.harmonics.length ? [{
    caption: fr ? 'Harmoniques' : 'Harmonics', head: ['H', 'Hz', `${spec.unit} RMS`, 'dBc'], numericFrom: 1,
    rows: spec.harmonics.map(h => [`H${h.order}`, axisValue(h.frequencyHz, 'Hz', locale), rms(h.vrms), formatFixed(h.dbc, 2, locale)]),
  }] : [])], format);
}
