import { columnInterval } from './columns.js';
import { median, quantile, valid } from './dsp.js';
import { measureChannel } from './measurements.js';
import type { ChannelId, ExtractionResult, TraceSample } from './types.js';

export interface ScopeCsvData {
  readonly format: 'siglent' | 'rigol' | 'generic';
  readonly columns: readonly string[];
  readonly rows: readonly { readonly timeSec: number; readonly values: readonly (number | null)[] }[];
}

export interface ScopeComparisonOptions {
  readonly channel?: ChannelId;
  readonly csvColumn?: string;
  readonly maxLagPx?: number;
}

export interface ScopeComparisonMetrics {
  readonly lagPx: number;
  readonly rmseV: number | null;
  readonly maeV: number | null;
  readonly maxErrorV: number | null;
  readonly rmsePx: number | null;
  readonly maePx: number | null;
  readonly medianPx: number | null;
  readonly p95Px: number | null;
  readonly rmsePctFs: number | null;
  readonly quantizationFloorPx: number;
  readonly coverage: number;
  readonly matchedCount: number;
  readonly vppDeltaV: number | null;
  readonly vppDeltaPct: number | null;
  readonly frequencyDeltaPct: number | null;
}

export interface ScopeComparisonResult {
  readonly channel: ChannelId;
  readonly csvColumn: string;
  readonly usableCount: number;
  readonly totalCount: number;
  readonly unaligned: ScopeComparisonMetrics;
  readonly aligned: ScopeComparisonMetrics;
}

function splitRow(line: string, separator: string): string[] {
  const cells: string[] = [];
  let value = '', quoted = false, closed = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        i++;
        value += '"';
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (closed || value.trim()) {
        throw new Error('Malformed quoted field in scope CSV.');
      } else {
        quoted = true;
      }
    } else if (ch === separator && !quoted) {
      cells.push(value.trim());
      value = '';
      closed = false;
    } else if (!closed || !ch.trim()) {
      value += ch;
    } else {
      throw new Error('Malformed quoted field in scope CSV.');
    }
  }
  if (quoted) throw new Error('Unclosed quoted field in scope CSV.');
  cells.push(value.trim());
  return cells;
}

const numeric = (value: string | undefined): number | null =>
  value && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const clean = (label: string) => label.trim().toLowerCase().replace(/\s+/g, ' ');
const timeHeader = /^(?:(?:x(?:-axis)?|time)(?:[\s_]*[(\[]?\s*(?:[mun\u00b5\u03bc]?s|seconds?)\s*[)\]]?)?|seconds?)$/i;
const channelHeader = /^(?:CH?\s*([1-4])(?=\b|_)|([1-4])(?=$|\s*[([]))/i;
const timeUnit = /^(?:([mun\u00b5\u03bc]?)s|seconds?)$/i;
const voltageUnit = /^(?:([muk\u00b5\u03bc]?)v|volts?)$/i;
const prefixes: Readonly<Record<string, number>> = { m: 1e-3, u: 1e-6, '\u00b5': 1e-6, '\u03bc': 1e-6, n: 1e-9, k: 1e3 };

function unit(label: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(clean(label).split(/[\s_(\[]+/).at(-1)?.replace(/[)\]]$/, '') ?? '');
}

function unitScale(pattern: RegExp, header: string, units = ''): number {
  const prefix = (unit(header, pattern) ?? unit(units, pattern))?.[1];
  return prefixes[prefix?.toLowerCase() ?? ''] ?? 1;
}

function tektronixData(row: readonly string[]): boolean {
  return row.length === 5 && !row[2] && numeric(row[3]) !== null;
}

interface CsvRow {
  readonly timeSec: number;
  readonly values: (number | null)[];
}

function checkedCsv(format: ScopeCsvData['format'], columns: string[], rows: CsvRow[]): ScopeCsvData {
  const unique: CsvRow[] = [];
  for (const row of rows.sort((a, b) => a.timeSec - b.timeSec)) {
    const previous = unique.at(-1);
    if (previous?.timeSec === row.timeSec) {
      for (const [column, value] of row.values.entries()) previous.values[column] ??= value;
    } else {
      unique.push(row);
    }
  }
  if (!unique.some(row => row.values.some(value => value !== null))) throw new Error('Scope CSV has no numeric voltage rows.');
  return { format, columns, rows: unique };
}

export function parseScopeCsv(text: string): ScopeCsvData {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  const separator = [',', ';', '\t'].find(delimiter => lines.some(line => {
    try {
      const row = splitRow(line, delimiter);
      return (timeHeader.test(row[0] ?? '') && row.slice(1).some(Boolean))
        || (tektronixData(row) && /^(?:record length|sample interval)$/i.test(row[0]!));
    } catch {
      return false;
    }
  }));
  if (!separator) throw new Error('Scope CSV needs a time column and at least one voltage column.');
  const records = lines.map(line => splitRow(line, separator));
  const index = records.findIndex(row => timeHeader.test(row[0] ?? '') && row.slice(1).some(Boolean));
  if (index < 0) {
    return checkedCsv('generic', ['Volt'], records.filter(tektronixData)
      .map(row => ({ timeSec: numeric(row[3])!, values: [numeric(row[4])] })));
  }
  const header = records[index]!;
  const isRigol = /^x$/i.test(header[0]!) && header.slice(1).some(cell => /^ch\s*\d/i.test(cell));
  const format = isRigol ? 'rigol' : /^second/i.test(header[0]!) || records.some(row => /^record length$/i.test(row[0]!))
    ? 'siglent' : 'generic';
  const metadataStart = isRigol ? header.findIndex(label => clean(label) === 'start') : -1;
  const metadataIncrement = isRigol ? header.findIndex(label => clean(label) === 'increment') : -1;
  const columnIndices = header.slice(1).flatMap((label, i) => label && i + 1 !== metadataStart && i + 1 !== metadataIncrement ? [i + 1] : []);
  const columns: string[] = [];
  for (const col of columnIndices) {
    const name = header[col]!;
    let unique = name, suffix = 2;
    while (columns.some(other => clean(other) === clean(unique))) unique = `${name} ${suffix++}`;
    columns.push(unique);
  }
  const lookup = (name: string) => records.find(row => clean(row[0]!) === name);
  const pairIndex = records.findIndex(row => clean(row[0]!) === 'start' && clean(row[1] ?? '') === 'increment');
  const pair = pairIndex < 0 ? undefined : records[pairIndex + 1];
  const embedded = records.slice(index + 1).find(row => numeric(row[metadataStart]) !== null && numeric(row[metadataIncrement]) !== null);
  const firstNumeric = (row: readonly string[] | undefined) => row?.slice(1).map(numeric).find(n => n !== null) ?? null;
  const start = numeric(embedded?.[metadataStart]) ?? numeric(pair?.[0]) ?? firstNumeric(lookup('start'));
  const increment = numeric(embedded?.[metadataIncrement]) ?? numeric(pair?.[1]) ?? firstNumeric(lookup('increment'));
  const data = records.slice(index + 1).filter((row, i) => row !== pair && i + index + 1 !== pairIndex && numeric(row[0]) !== null);
  const indexes = isRigol && start !== null && increment !== null && increment > 0
    && data.every(row => Number.isInteger(numeric(row[0])));
  const units = records[index + 1];
  const firstUnit = clean(units?.[0] ?? '');
  const unitsRow = units && (unit(firstUnit, timeUnit) || firstUnit === 'sequence'
    || (/^(?:units?)?$/.test(firstUnit) && columnIndices.some(col => unit(units[col] ?? '', voltageUnit)))) ? units : undefined;
  const timeScale = unitScale(timeUnit, header[0]!, unitsRow?.[0]);
  const voltageScales = columnIndices.map(col => unitScale(voltageUnit, header[col]!, unitsRow?.[col]));
  const rows = data.map(row => ({
    timeSec: (indexes ? start! + numeric(row[0])! * increment! : numeric(row[0])!) * timeScale,
    values: columnIndices.map((col, i) => {
      const value = numeric(row[col]);
      const volts = value === null ? NaN : value * voltageScales[i]!;
      return Number.isFinite(volts) ? volts : null;
    }),
  })).filter(row => Number.isFinite(row.timeSec));
  return checkedCsv(format, columns, rows);
}

function referenceAt(csv: ScopeCsvData, column: number, time: number, tolerance: number): number | null {
  const { rows } = csv;
  let low = 0, high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid]!.timeSec < time) low = mid + 1;
    else high = mid;
  }
  const earlier = rows[low - 1], later = rows[low];
  if (later && Math.abs(later.timeSec - time) <= tolerance) return later.values[column] ?? null;
  if (earlier && Math.abs(earlier.timeSec - time) <= tolerance) return earlier.values[column] ?? null;
  const a = earlier?.values[column], b = later?.values[column];
  if (a == null || b == null) return null;
  if (a === b) return a;
  const fraction = (time - earlier!.timeSec) / (later!.timeSec - earlier!.timeSec);
  return a * (1 - fraction) + b * fraction;
}

export function compareWithScopeCsv(result: ExtractionResult, csv: ScopeCsvData,
  options: ScopeComparisonOptions = {}): ScopeComparisonResult {
  const available = result.traces.filter(t => t.settings.enabled);
  const named = csv.columns.map(label => {
    const match = channelHeader.exec(label);
    return match?.[1] ?? match?.[2];
  });
  const trace = options.channel ? available.find(t => t.channel === options.channel)
    : (options.csvColumn === undefined ? available.find(t => named.includes(t.channel[1])) : undefined) ?? available[0];
  if (!trace) throw new Error(options.channel ? `Missing enabled channel ${options.channel}.` : 'The screenshot has no enabled analog channel.');
  const { channel, settings } = trace;
  const channelIndex = named.indexOf(channel[1]);
  if (options.csvColumn === undefined && channelIndex < 0 && named.some(Boolean)) {
    throw new Error(`Scope CSV is missing channel ${channel}.`);
  }
  const column = options.csvColumn === undefined ? Math.max(channelIndex, 0) : csv.columns.findIndex(label => clean(label) === clean(options.csvColumn!));
  const csvColumn = csv.columns[column];
  if (!csvColumn) throw new Error(`Unknown CSV column ${options.csvColumn ?? channel}.`);
  const grid = result.detection.grid, dt = columnInterval(result), pixel = settings.voltsPerDiv / grid.pxPerVDiv;
  const start = trace.samples[0]?.timeSec ?? Infinity;
  const end = trace.samples.at(-1)?.timeSec ?? -Infinity;
  const tolerance = Math.abs(dt) * 1e-8;
  const ref = (time: number) => time >= start - tolerance && time <= end + tolerance ? referenceAt(csv, column, time, tolerance) : null;
  const usable = trace.samples.filter(valid);
  const requestedLag = options.maxLagPx ?? 2.5;
  const steps = Number.isFinite(requestedLag) ? Math.floor(Math.min(2.5, Math.max(0, requestedLag)) * 10 + 1e-9) : 25;
  const candidates = Array.from({ length: 2 * steps + 1 }, (_, i) => (i - steps) / 10)
    .sort((a, b) => Math.abs(a) - Math.abs(b));
  const common = usable.filter(s => candidates.every(lag => ref(s.timeSec + lag * dt) !== null));
  const alignmentSamples = common.length >= 2 ? common : usable;
  const score = (lag: number) => {
    let sum = 0, count = 0;
    let first: number | undefined, varying = false;
    for (const sample of alignmentSamples) {
      const voltage = ref(sample.timeSec + lag * dt);
      if (voltage === null) continue;
      first ??= voltage;
      varying ||= voltage !== first;
      sum += ((sample.voltage! - voltage) / pixel) ** 2;
      count++;
    }
    return count >= 2 && (common.length >= 2 || lag === 0 || varying) ? sum / count : Infinity;
  };
  let bestLag = 0, bestScore = Infinity;
  for (const lag of candidates) {
    const error = score(lag);
    if (error < bestScore) {
      bestScore = error;
      bestLag = lag;
    }
  }
  const measure = (samples: readonly TraceSample[]) => measureChannel({ ...trace, samples, clippedCount: 0 }, grid.pxPerVDiv);
  const metrics = (lagPx: number): ScopeComparisonMetrics => {
    const screenshot: TraceSample[] = [], reference: TraceSample[] = [], errors: number[] = [];
    for (const s of usable) {
      const v = ref(s.timeSec + lagPx * dt);
      if (v === null || !Number.isFinite(v)) continue;
      screenshot.push(s);
      reference.push({ ...s, voltage: v });
      errors.push(Math.abs(s.voltage! - v));
    }
    errors.sort((a, b) => a - b);
    const matchedCount = errors.length, maxErrorV = errors.at(-1) ?? null;
    const rmseV = maxErrorV === null ? null : maxErrorV === 0 ? 0
      : maxErrorV * Math.sqrt(errors.reduce((sum, value) => sum + (value / maxErrorV) ** 2, 0) / matchedCount);
    const maeV = matchedCount ? errors.reduce((sum, value) => sum + value / matchedCount, 0) : null;
    const toPx = (value: number | null) => value !== null && pixel > 0 ? value / pixel : null;
    const actual = measure(screenshot), expected = measure(reference);
    const delta = (a: number | null, b: number | null) => a !== null && b !== null ? a - b : null;
    const percent = (a: number | null, b: number | null) => a !== null && b !== null && b !== 0 ? 100 * (a / b) : null;
    const vppDeltaV = delta(actual.vpp, expected.vpp);
    return {
      lagPx, rmseV, maeV, maxErrorV, matchedCount, rmsePx: toPx(rmseV), maePx: toPx(maeV),
      medianPx: matchedCount ? toPx(median(errors)) : null, p95Px: matchedCount ? toPx(quantile(errors, 0.95)) : null,
      rmsePctFs: percent(rmseV, settings.voltsPerDiv * grid.vDivs), quantizationFloorPx: 1 / Math.sqrt(12),
      coverage: usable.length ? matchedCount / usable.length : 0,
      vppDeltaV, vppDeltaPct: percent(vppDeltaV, expected.vpp),
      frequencyDeltaPct: percent(delta(actual.frequencyHz, expected.frequencyHz), expected.frequencyHz),
    };
  };
  const unaligned = metrics(0);
  return { channel, csvColumn, usableCount: usable.length, totalCount: trace.samples.length,
    unaligned, aligned: bestLag === 0 ? unaligned : metrics(bestLag) };
}
