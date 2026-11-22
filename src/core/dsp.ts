import type { ChannelTrace, TraceSample } from './types.js';

export const median = (sorted: readonly number[]) => quantile(sorted, 0.5);

export function quantile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return NaN;
  const index = fraction * (sorted.length - 1);
  const below = Math.floor(index);
  const above = Math.ceil(index);
  if (below === above) return sorted[below]!;
  const lower = sorted[below]!;
  const upper = sorted[above]!;
  const weight = index - below;
  return lower < 0 && upper > 0 ? lower * (1 - weight) + upper * weight : lower + (upper - lower) * weight;
}

export function wrapPhase(degrees: number): number {
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

interface SineFit {
  readonly amplitude: number;
  readonly phaseDeg: number;
  readonly r2: number;
}

interface SharedSample {
  readonly time: number;
  readonly input: number;
  readonly output: number;
}

export interface SharedFit {
  readonly input: SineFit | null;
  readonly output: SineFit | null;
  readonly cycles: number;
  readonly colsPerCycle: number;
  readonly vinPx: number;
  readonly voutPx: number;
  readonly contiguousCycles: number;
  readonly observedCycles: number;
  readonly largestGapCycles: number;
  readonly nyquist: boolean;
  readonly sufficientCoverage: boolean;
}

function solveFit(rows: readonly SharedSample[], frequencyHz: number, key: 'input' | 'output'): SineFit | null {
  if (rows.length < 5) return null;
  const first = rows[0]!.time;
  const firstVoltage = rows[0]![key];
  const angular = 2 * Math.PI * frequencyHz;
  let sumCos = 0;
  let sumSin = 0;
  let sumY = 0;
  let sumCos2 = 0;
  let sumSin2 = 0;
  let sumCosSin = 0;
  let sumYCos = 0;
  let sumYSin = 0;
  let sumY2 = 0;
  for (const row of rows) {
    const t = (row.time - first) * angular;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const y = row[key] - firstVoltage;
    sumCos += cos;
    sumSin += sin;
    sumY += y;
    sumCos2 += cos * cos;
    sumSin2 += sin * sin;
    sumCosSin += cos * sin;
    sumYCos += y * cos;
    sumYSin += y * sin;
    sumY2 += y * y;
  }

  const n = rows.length;
  const cos2 = sumCos2 - sumCos * sumCos / n;
  const sin2 = sumSin2 - sumSin * sumSin / n;
  const cosSin = sumCosSin - sumCos * sumSin / n;
  const yCos = sumYCos - sumY * sumCos / n;
  const ySin = sumYSin - sumY * sumSin / n;
  const y2 = sumY2 - sumY * sumY / n;
  const det = cos2 * sin2 - cosSin * cosSin;
  if (det <= n * n * 1e-12 || y2 <= Number.EPSILON * Math.max(sumY2, Number.MIN_VALUE) * 16) return null;
  const a = (yCos * sin2 - ySin * cosSin) / det;
  const b = (ySin * cos2 - yCos * cosSin) / det;
  const amplitude = Math.hypot(a, b);
  const r2 = (a * yCos + b * ySin) / y2;
  if (!Number.isFinite(amplitude) || !Number.isFinite(r2)) return null;
  return {
    amplitude, phaseDeg: Math.atan2(-b, a) * 180 / Math.PI,
    r2: Math.max(0, Math.min(1, r2)),
  };
}

export function fitShared(input: ChannelTrace, output: ChannelTrace, frequencyHz: number): SharedFit {
  const shared: SharedSample[] = [];
  let minIn = Infinity;
  let maxIn = -Infinity;
  let minOut = Infinity;
  let maxOut = -Infinity;
  let lastColumn = 0;
  let segmentStart = 0;
  let contiguousCycles = 0;
  let observedCycles = 0;
  let largestGapCycles = 0;
  const pixelSteps: number[] = [];
  const outputByColumn = new Map(output.samples.map(sample => [sample.col, sample]));
  for (const a of input.samples) {
    const b = outputByColumn.get(a.col);
    if (!b || !valid(a) || !valid(b) || a.timeSec !== b.timeSec || a.yPx === null || b.yPx === null
        || !Number.isFinite(a.timeSec)) continue;
    const previous = shared.at(-1);
    if (!previous) {
      segmentStart = a.timeSec;
    } else {
      const columns = a.col - lastColumn;
      const elapsed = a.timeSec - previous.time;
      if (columns <= 0 || elapsed <= 0) continue;
      const step = elapsed * frequencyHz;
      pixelSteps.push(step / columns);
      largestGapCycles = Math.max(largestGapCycles, step);
      if (columns === 1) observedCycles += step;
      if (columns > 1 && step > 1 / 8) segmentStart = a.timeSec;
      contiguousCycles = Math.max(contiguousCycles, (a.timeSec - segmentStart) * frequencyHz);
    }
    lastColumn = a.col;
    shared.push({ time: a.timeSec, input: a.voltage, output: b.voltage });
    minIn = Math.min(minIn, a.yPx);
    maxIn = Math.max(maxIn, a.yPx);
    minOut = Math.min(minOut, b.yPx);
    maxOut = Math.max(maxOut, b.yPx);
  }
  const cycles = shared.length > 1 ? (shared.at(-1)!.time - shared[0]!.time) * frequencyHz : 0;
  const colsPerCycle = cycles > 0 ? (shared.length - 1) / cycles : 0;
  const pixelStepCycles = median(pixelSteps.sort((a, b) => a - b));
  const nyquist = pixelStepCycles > 0 && pixelStepCycles < 0.5 && colsPerCycle > 2;
  const sufficientCoverage = nyquist && colsPerCycle >= 6 && contiguousCycles >= 1 - 1e-9
    && observedCycles >= 0.85 && observedCycles >= cycles * 0.85
    && largestGapCycles <= Math.max(1 / 8, pixelStepCycles * 1.01);
  return {
    input: sufficientCoverage ? solveFit(shared, frequencyHz, 'input') : null,
    output: sufficientCoverage ? solveFit(shared, frequencyHz, 'output') : null,
    cycles, colsPerCycle, contiguousCycles, observedCycles, largestGapCycles, nyquist, sufficientCoverage,
    vinPx: shared.length ? maxIn - minIn : 0, voutPx: shared.length ? maxOut - minOut : 0,
  };
}

export function valid(sample: TraceSample): sample is TraceSample & { readonly voltage: number } {
  return sample.status === 'ok' && sample.voltage !== null && Number.isFinite(sample.voltage);
}
