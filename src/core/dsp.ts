import type { ChannelTrace, TraceSample } from './types.js';

export const median = (sorted: readonly number[]) => quantile(sorted, 0.5);

export function quantile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return NaN;
  const index = fraction * (sorted.length - 1);
  const below = Math.floor(index);
  const above = Math.ceil(index);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (index - below);
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
  return {
    amplitude: Math.hypot(a, b), phaseDeg: Math.atan2(-b, a) * 180 / Math.PI,
    r2: Math.max(0, Math.min(1, (a * yCos + b * ySin) / y2)),
  };
}

export function fitShared(input: ChannelTrace, output: ChannelTrace, frequencyHz: number): SharedFit {
  const shared: SharedSample[] = [];
  let minIn = Infinity;
  let maxIn = -Infinity;
  let minOut = Infinity;
  let maxOut = -Infinity;
  let firstColumn = 0;
  let lastColumn = 0;
  const outputByColumn = new Map(output.samples.map(sample => [sample.col, sample]));
  for (const a of input.samples) {
    const b = outputByColumn.get(a.col);
    if (!b || !valid(a) || !valid(b) || a.timeSec !== b.timeSec || a.yPx === null || b.yPx === null) continue;
    if (!shared.length) firstColumn = a.col;
    lastColumn = a.col;
    shared.push({ time: a.timeSec, input: a.voltage, output: b.voltage });
    minIn = Math.min(minIn, a.yPx);
    maxIn = Math.max(maxIn, a.yPx);
    minOut = Math.min(minOut, b.yPx);
    maxOut = Math.max(maxOut, b.yPx);
  }
  const cycles = shared.length > 1 ? (shared.at(-1)!.time - shared[0]!.time) * frequencyHz : 0;
  return {
    input: solveFit(shared, frequencyHz, 'input'), output: solveFit(shared, frequencyHz, 'output'),
    cycles, colsPerCycle: cycles > 0 ? Math.min(lastColumn - firstColumn, shared.length) / cycles : 0,
    vinPx: shared.length ? maxIn - minIn : 0, voutPx: shared.length ? maxOut - minOut : 0,
  };
}

export function valid(sample: TraceSample): sample is TraceSample & { readonly voltage: number } {
  return sample.status === 'ok' && sample.voltage !== null && Number.isFinite(sample.voltage);
}
