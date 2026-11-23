import { columnSamples, columnInterval, isClipped, samplesFor, sampleStatus } from './columns.js';
import { fitShared, median, quantile, valid, wrapPhase } from './dsp.js';
import { analysisPlot, axisValue, niceCeiling125 } from './export/analysis-plot.js';
import type { AnalysisPlotOptions } from './export/analysis-plot.js';
import { csvComment } from './export/csv.js';
import { csvNumber, GRATICULE_VERSION } from './export/format.js';
import type { ChannelTrace, ExtractionResult, GapStatus, MathTraceResult, TraceSample, XyAxisId } from './types.js';

export type { XyAxisId } from './types.js';

export interface XyPoint {
  readonly col: number;
  readonly timeSec: number;
  readonly x: number | null;
  readonly y: number | null;
  readonly xStatus: GapStatus;
  readonly yStatus: GapStatus;
}

export type XyValidPoint = XyPoint & { readonly x: number; readonly y: number };

export interface XyResult {
  readonly xAxis: XyAxisId;
  readonly yAxis: XyAxisId;
  readonly xUnit: 'V' | 'V²';
  readonly yUnit: 'V' | 'V²';
  readonly points: readonly XyPoint[];
  readonly segments: readonly (readonly XyValidPoint[])[];
  readonly xMin: number | null;
  readonly xMax: number | null;
  readonly xVpp: number | null;
  readonly yMin: number | null;
  readonly yMax: number | null;
  readonly yVpp: number | null;
  readonly validCount: number;
  readonly gapCount: number;
  readonly clippedX: boolean;
  readonly clippedY: boolean;
  readonly lissajousPhaseDeg: number | null;
  readonly hysteresis: { readonly lowThresholdV: number; readonly highThresholdV: number; readonly widthV: number } | null;
}

export interface XySvgOptions extends AnalysisPlotOptions {
  readonly xLabel?: string;
  readonly yLabel?: string;
}

function findHysteresis(segments: XyResult['segments'], ys: readonly number[], xSwing: number): XyResult['hysteresis'] {
  const lo = ys[0] ?? 0, hi = ys.at(-1) ?? 0;
  const span = hi - lo;
  if (!(span > 0) || !(xSwing > 0)
      || ys.filter(y => Math.min(Math.abs(y - lo), Math.abs(y - hi)) <= span * 0.12).length < ys.length * 0.87) return null;
  const rising: number[] = [], falling: number[] = [];
  const mid = lo + span / 2;
  let maxEdgeStepX = 0, risingDirection = 0, fallingDirection = 0;
  for (const segment of segments) {
    let state = 0;
    let candidate: { x: number; step: number } | null = null;
    for (let i = 0; i < segment.length; i++) {
      const p = segment[i]!, last = segment[i - 1];
      if (last && (p.y >= mid) !== (last.y >= mid)) {
        const f = (mid - last.y) / (p.y - last.y);
        candidate = { x: (1 - f) * last.x + f * p.x, step: p.x - last.x };
      }
      const next = p.y <= lo + span * 0.2 ? -1 : p.y >= hi - span * 0.2 ? 1 : 0;
      if (next && next !== state) {
        if (state && candidate !== null) {
          if (next > 0) {
            rising.push(candidate.x);
            risingDirection += Math.sign(candidate.step);
          } else {
            falling.push(candidate.x);
            fallingDirection += Math.sign(candidate.step);
          }
          maxEdgeStepX = Math.max(maxEdgeStepX, Math.abs(candidate.step));
        }
        state = next;
        candidate = null;
      }
    }
  }
  if (risingDirection * fallingDirection >= 0) return null;
  const stable = (values: number[]) => {
    values.sort((a, b) => a - b);
    return quantile(values, 0.9) - quantile(values, 0.1) <= xSwing * 0.1;
  };
  if (!stable(rising) || !stable(falling)) return null;
  const a = median(rising), b = median(falling);
  const widthV = Math.abs(a - b);
  return widthV > Math.max(xSwing * 0.03, 2 * maxEdgeStepX)
    ? { lowThresholdV: Math.min(a, b), highThresholdV: Math.max(a, b), widthV } : null;
}

function sinePhase(result: ExtractionResult, axes: readonly [XyAxisId, XyAxisId],
  samples: readonly [readonly TraceSample[], readonly TraceSample[]], segments: XyResult['segments'],
  xSpan: number, ySpan: number, math?: MathTraceResult | null): number | null {
  if (!(xSpan > 0 && ySpan > 0)) return null;
  const measurement = (axis: XyAxisId) => axis === 'M' ? math?.measurement : result.measurements.find(m => m.channel === axis);
  const [f1, f2] = axes.map(axis => measurement(axis)?.frequencyHz ?? null);
  if (f1 && f2 && Math.abs(f1 / f2 - 1) > 0.04) return null;
  const [base] = result.traces;
  if (!base) return null;
  const traces = samples.map((series, i): ChannelTrace => ({
    ...base, samples: series.map(s => valid(s) ? { ...s, yPx: s.yPx ?? s.voltage } : s),
    settings: { ...base.settings, channel: axes[i] === 'M' ? base.channel : axes[i]! },
  }));
  const fitAt = (hz: number) => {
    const { input, output } = fitShared(traces[0]!, traces[1]!, hz);
    if (!input || !output || input.r2 < 0.96 || output.r2 < 0.96) return null;
    // Triangle waves can pass the R² gate, but have a strong third harmonic.
    if (Math.min(input.r2, output.r2) < 0.99) {
      const origin = samples[0].find((s, j) => valid(s) && valid(samples[1][j]!))!.timeSec;
      const residual = traces.map((trace, i): ChannelTrace => {
        const fit = i === 0 ? input : output;
        const phase = fit.phaseDeg * Math.PI / 180;
        return { ...trace, samples: trace.samples.map(s => valid(s) ? {
          ...s, voltage: s.voltage - fit.amplitude * Math.cos(2 * Math.PI * ((s.timeSec - origin) * hz % 1) + phase),
        } : s) };
      });
      const third = fitShared(residual[0]!, residual[1]!, 3 * hz);
      if ((third.input?.amplitude ?? 0) > 0.09 * input.amplitude
        || (third.output?.amplitude ?? 0) > 0.09 * output.amplitude) return null;
    }
    return wrapPhase(output.phaseDeg - input.phaseDeg);
  };
  if (f1 || f2) {
    const f = f1 && f2 ? (f1 + f2) / 2 : (f1 ?? f2)!;
    const phase = fitAt(f);
    if (phase !== null) return phase;
  }
  const longest = segments.reduce<readonly XyValidPoint[]>((a, b) => b.length > a.length ? b : a, []);
  const first = longest[0];
  if (!first || longest.length < 17) return null;
  const distance = (p: XyValidPoint) => Math.hypot((p.x - first.x) / xSpan, (p.y - first.y) / ySpan);
  const dt = columnInterval(result);
  const tolerance = Math.max(0.035, Math.min(0.12, distance(longest[1]!) * 1.5));
  let traveled = false;
  for (let i = 1; i < longest.length; i++) {
    const p = longest[i]!, d = distance(p);
    traveled ||= d > 0.55;
    if (!traveled || i < 8 || d > tolerance || d >= distance(longest[i - 1]!)
      || (longest[i + 1] && d > distance(longest[i + 1]!))) continue;
    const phase = fitAt(1 / (i * dt));
    if (phase !== null) return phase;
  }
  return null;
}

export function computeXyPlot(result: ExtractionResult, xAxis: XyAxisId, yAxis: XyAxisId,
  math?: MathTraceResult | null): XyResult {
  const xs = columnSamples(result, samplesFor(result, xAxis, math));
  const ys = columnSamples(result, samplesFor(result, yAxis, math));
  const points: XyPoint[] = [], segments: XyValidPoint[][] = [];
  let clippedX = false, clippedY = false, validCount = 0;
  let segment: XyValidPoint[] | undefined;
  for (const [col, a] of xs.entries()) {
    const b = ys[col]!;
    const xStatus = sampleStatus(a), yStatus = sampleStatus(b);
    clippedX ||= isClipped(xStatus); clippedY ||= isClipped(yStatus);
    const p = { col, timeSec: a.timeSec, x: valid(a) ? a.voltage : null, y: valid(b) ? b.voltage : null, xStatus, yStatus };
    points.push(p);
    if (p.x === null || p.y === null) {
      segment = undefined;
      continue;
    }
    if (!segment) segments.push(segment = []);
    segment.push({ ...p, x: p.x, y: p.y });
    validCount++;
  }
  const xx = points.flatMap(p => p.x === null ? [] : [p.x]).sort((a, b) => a - b);
  const yy = points.flatMap(p => p.y === null ? [] : [p.y]).sort((a, b) => a - b);
  const xMin = xx[0] ?? null, xMax = xx.at(-1) ?? null, yMin = yy[0] ?? null, yMax = yy.at(-1) ?? null;
  const xVpp = xMin === null ? null : xMax! - xMin, yVpp = yMin === null ? null : yMax! - yMin;
  const unit = (axis: XyAxisId) => axis === 'M' ? math?.unit ?? 'V' : 'V';
  const clean = !clippedX && !clippedY;
  return {
    xAxis, yAxis, xUnit: unit(xAxis), yUnit: unit(yAxis), points, segments, xMin, xMax, xVpp, yMin, yMax, yVpp,
    validCount, gapCount: points.length - validCount, clippedX, clippedY,
    lissajousPhaseDeg: clean ? sinePhase(result, [xAxis, yAxis], [xs, ys], segments, xVpp ?? 0, yVpp ?? 0, math) : null,
    hysteresis: clean ? findHysteresis(segments, yy, xVpp ?? 0) : null,
  };
}

export function renderXySvg(xy: XyResult, opts: XySvgOptions = {}): string {
  const locale = opts.locale ?? 'en';
  const range = (lo: number, hi: number, unit: XyResult['xUnit']) => {
    const constant = lo === hi;
    const padding = constant ? Math.max(1, Math.abs(lo) * 0.1)
      : Math.max((hi / 2 - lo / 2) * 0.02, Math.max(Math.abs(lo), Math.abs(hi)) * Number.EPSILON * 8, Number.MIN_VALUE);
    const paddedMin = Math.max(-Number.MAX_VALUE, lo - padding), paddedMax = Math.min(Number.MAX_VALUE, hi + padding);
    const step = niceCeiling125((paddedMax / 2 - paddedMin / 2) / 3 || Number.MIN_VALUE);
    const first = Math.floor((constant ? paddedMin : lo) / step);
    const last = Math.ceil((constant ? paddedMax : hi) / step);
    const min = Math.max(-Number.MAX_VALUE, Math.min(paddedMin, first * step));
    const max = Math.min(Number.MAX_VALUE, Math.max(paddedMax, last * step));
    const magnitude = Math.max(Math.abs(min), Math.abs(max));
    const sig = Math.max(3, Math.floor(Math.log10(magnitude)) - Math.floor(Math.log10(step)) + 1);
    const span = max - min;
    const fraction = (v: number) => Number.isFinite(span) ? (v - min) / span : (v / 2 - min / 2) / (max / 2 - min / 2);
    const ticks = Array.from({ length: last - first + 1 }, (_, i) => (first + i) * step).filter(Number.isFinite)
      .map(value => ({ fraction: fraction(value), label: axisValue(value, unit, locale, sig) }));
    return { fraction, ticks };
  };
  const a = range(xy.xMin ?? 0, xy.xMax ?? 0, xy.xUnit), b = range(xy.yMin ?? 0, xy.yMax ?? 0, xy.yUnit);
  const label = (axis: string, unit: string) => `${axis} (${unit})`;
  return analysisPlot(opts, opts.title ?? `${xy.xAxis} / ${xy.yAxis}`, true,
    label(opts.xLabel ?? xy.xAxis, xy.xUnit), label(opts.yLabel ?? xy.yAxis, xy.yUnit),
    a.ticks, b.ticks, (x, y, ink) => {
      const px = (p: XyValidPoint) => x(a.fraction(p.x)), py = (p: XyValidPoint) => y(b.fraction(p.y));
      const plot = xy.segments.map(s => s.length === 1
        ? `<circle cx="${px(s[0]!)}" cy="${py(s[0]!)}" r="1.5" fill="${ink}"/>`
        : `<polyline points="${s.map(p => `${px(p)},${py(p)}`).join(' ')}" fill="none" stroke="${ink}" stroke-width="1.2"/>`).join('');
      const rails = [
        xy.points.some(p => p.xStatus === 'clipped_low') && `M${x(0)} ${y(0.4)}V${y(0.6)}`,
        xy.points.some(p => p.xStatus === 'clipped_high') && `M${x(1)} ${y(0.4)}V${y(0.6)}`,
        xy.points.some(p => p.yStatus === 'clipped_low') && `M${x(0.4)} ${y(0)}H${x(0.6)}`,
        xy.points.some(p => p.yStatus === 'clipped_high') && `M${x(0.4)} ${y(1)}H${x(0.6)}`,
      ].filter(Boolean).join(' ');
      return `<g clip-path="url(#analysis-plot-clip)">${plot}</g>`
        + (rails ? `<path aria-label="${locale === 'fr' ? 'Écrêtage' : 'Clipped rail'}" d="${rails}" stroke="${ink}" stroke-dasharray="3 2" stroke-width="3"/>` : '');
    });
}

export function renderXyCsv(xy: XyResult, title?: string): string {
  return [
    `# Graticule v${GRATICULE_VERSION}`,
    ...(title?.trim() ? [`# title: ${csvComment(title)}`] : []),
    `# x: ${xy.xAxis} (${xy.xUnit}), y: ${xy.yAxis} (${xy.yUnit})`,
    `column,time_s,x_${xy.xUnit === 'V²' ? 'v2' : 'v'},y_${xy.yUnit === 'V²' ? 'v2' : 'v'},x_status,y_status`,
    ...xy.points.map(p => [p.col, csvNumber(p.timeSec), csvNumber(p.x), csvNumber(p.y), p.xStatus, p.yStatus].join(',')),
  ].join('\n') + '\n';
}
