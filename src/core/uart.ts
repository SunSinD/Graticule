import { columnInterval, columnSamples, samplesFor } from './columns.js';
import { quantile, valid } from './dsp.js';
import type { ChannelId, ExtractionResult, TraceSample } from './types.js';

export interface UartOptions {
  readonly channel: ChannelId;
  readonly baud?: number | 'auto';
  readonly dataBits?: 7 | 8;
  readonly parity?: 'none' | 'even' | 'odd';
  readonly stopBits?: 1 | 2;
  readonly idleHigh?: boolean;
  readonly thresholdVolts?: number;
}

export interface UartFrame {
  readonly startSec: number;
  readonly endSec: number;
  readonly byte: number | null;
  readonly hex: string;
  readonly ascii: string;
  readonly framingError: boolean;
  readonly parityError: boolean;
  readonly uncertain: boolean;
}

export interface UartDecodeResult {
  readonly channel: ChannelId;
  readonly baud: number | null;
  readonly pxPerBit: number | null;
  readonly thresholdVolts: number | null;
  readonly dataBits: 7 | 8;
  readonly parity: 'none' | 'even' | 'odd';
  readonly stopBits: 1 | 2;
  readonly idleHigh: boolean;
  readonly frames: readonly UartFrame[];
  readonly text: string;
  readonly rawText: string;
  readonly reason: 'insufficient_resolution' | 'insufficient_levels' | 'baud_unresolved' | 'no_frames' | null;
  readonly warnings: readonly string[];
}

export const STANDARD_UART_BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600] as const;
const MIN_PX_PER_BIT = 6;

interface Edge {
  readonly col: number;
  readonly bit: 0 | 1;
  readonly gap?: readonly [number, number];
}

function findEdges(samples: readonly TraceSample[], threshold: number, band: number, idleHigh: boolean): Edge[] {
  const edges: Edge[] = [];
  let previous: TraceSample | undefined, state: 0 | 1 | undefined;
  let midpoint: number | undefined;
  let gap: Edge['gap'];
  for (const sample of samples) {
    if (!valid(sample)) continue;
    const high = sample.voltage >= threshold;
    const last = previous;
    if (last && (last.voltage! >= threshold) !== high) {
      gap = sample.col !== last.col + 1 ? [last.col + 0.5, sample.col - 0.5] : undefined;
      midpoint = gap ? (gap[0] + gap[1]) / 2
        : last.col + (threshold - last.voltage!) / (sample.voltage - last.voltage!);
    }
    if (Math.abs(sample.voltage - threshold) >= band) {
      const bit = Number(high === idleHigh) as 0 | 1;
      if (state !== bit && state !== undefined && midpoint !== undefined) edges.push({ col: midpoint, bit, gap });
      state = bit;
      midpoint = undefined;
    }
    previous = sample;
  }
  return edges;
}

function inspect(samples: readonly TraceSample[], edges: Edge[], px: number, threshold: number,
  dt: number, options: Pick<Required<UartOptions>, 'dataBits' | 'parity' | 'stopBits' | 'idleHigh'>, firstEdge: number) {
  const { dataBits, parity, stopBits, idleHigh } = options;
  const parityBits = Number(parity !== 'none'), length = 1 + dataBits + parityBits + stopBits;
  const frames: UartFrame[] = [];
  const read = (at: number) => {
    const cols = [...new Set([0.33, 0.5, 0.67].map(f => Math.round(at + f * px)))];
    let ones = 0, zeroes = 0;
    for (const col of cols) {
      const s = samples[col];
      if (!s || !valid(s)) continue;
      if ((s.voltage >= threshold) === idleHigh) ones++;
      else zeroes++;
    }
    return { bit: ones === zeroes ? null : Number(ones > zeroes), uncertain: Math.max(ones, zeroes) !== cols.length };
  };
  let alignment = 0, included = 0, frameStarts = 0, good = 0, bad = 0, short = 0;
  let croppedStop = false;
  let previousFrameGood = false;
  let nextCol = 0;
  for (let i = firstEdge; i < edges.length; i++) {
    const edge = edges[i]!;
    if (edge.bit) continue;
    let start = edge.col;
    const previousEnd = nextCol + 0.25 * px;
    if (edge.gap) {
      const [first, last] = edge.gap;
      if (frames.length && first <= previousEnd && previousEnd <= last) {
        start = previousEnd;
      } else {
        const following = edges.find((next, j) => j > i && !next.gap);
        if (following) {
          const phase = following.col - Math.round((following.col - start) / px) * px;
          if (phase >= first && phase <= last) start = phase;
        }
      }
    }
    if (start < nextCol || start + (length - stopBits - 0.35) * px > samples.length - 0.5) continue;
    const previous = edges[i - 1];
    if (previous && start - (previous.gap?.[0] ?? previous.col) < px * 0.62) continue;
    const startBit = read(start);
    const nextBoundary = previousEnd + length * px;
    const boundaryStatus = samples[Math.ceil(previousEnd)]?.status;
    // If a mask hid an expected start, a later data edge can look like a
    // start. A clean falling edge one frame later confirms where to resume.
    if (frames.length && start < nextBoundary - 0.3 * px && (startBit.bit === null || start > previousEnd + 0.35 * px)
        && (boundaryStatus === 'masked_cursor' || boundaryStatus === 'masked_overlay')
        && edges.some(next => !next.bit && !next.gap && Math.abs(next.col - nextBoundary) <= 0.25 * px)) {
      nextCol = nextBoundary - 0.25 * px;
      continue;
    }
    if (startBit.bit !== 0) {
      if (startBit.bit === null && edge.gap && edge.gap[1] < start + 0.9 * px) {
        nextCol = start + (length - 0.25) * px;
      }
      continue;
    }
    const bits = Array.from({ length }, (_, k) => k === 0 ? startBit : read(start + k * px));
    let byte: number | null = 0, sum = 0;
    for (let k = 0; k < dataBits; k++) {
      const bit = bits[k + 1]!.bit;
      if (bit === null) byte = null;
      else {
        sum += bit;
        if (byte !== null) byte += bit << k;
      }
    }
    const parityBit = bits[dataBits + 1]!.bit;
    const parityError = parity !== 'none' && byte !== null && parityBit !== null
      && (sum + parityBit) % 2 !== Number(parity === 'odd');
    const stops = bits.slice(-stopBits);
    const stopHigh = stops.every(bit => bit.bit === 1);
    const end = start + length * px;
    const truncated = end > samples.length - 0.5 + 1e-9;
    const framingError = truncated || !stopHigh;
    const lastCol = Math.ceil(end);
    const uncertain = truncated || Boolean(edge.gap) || bits.some(bit => bit.uncertain)
      || samples.slice(Math.ceil(start), lastCol).some(sample => !valid(sample));
    const decoded = !parityError && byte !== null && stopHigh;
    const frameGood = decoded && !truncated;
    if (frameGood) {
      good++;
      if (previousFrameGood && !edge.gap && start <= previousEnd + 0.25 * px) frameStarts++;
    } else {
      bad++;
      croppedStop ||= decoded;
    }
    previousFrameGood = frameGood;
    for (let j = i + 1; j < edges.length && edges[j]!.col < start + (length - 0.25) * px; j++) {
      const phase = (edges[j]!.col - start) / px;
      const gap = (edges[j]!.col - edges[j - 1]!.col) / px;
      alignment += Math.abs(phase - Math.round(phase));
      included++;
      if (gap < 0.69) short++;
    }
    const time = samples[0]!.timeSec + start * dt;
    frames.push({
      startSec: time, endSec: time + length * px * dt, byte,
      hex: byte === null ? '' : byte.toString(16).toUpperCase().padStart(2, '0'),
      ascii: byte === null ? '' : byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.',
      framingError, parityError, uncertain,
    });
    nextCol = end - 0.25 * px;
    const stopMasked = stops.some(bit => bit.bit === null) && samples.slice(Math.ceil(end - stopBits * px), lastCol)
      .some(sample => sample.status === 'masked_cursor' || sample.status === 'masked_overlay');
    // A hidden stop pulse can leave both sides of the next start at the same level.
    if (stopMasked && read(end).bit === 0) {
      const insertAt = edges.findIndex((next, j) => j > i && next.col >= nextCol);
      const next = edges[insertAt];
      if (next && next.col > end && next.col < end + (length - 0.25) * px
          && (next.col > end + 0.25 * px || next.bit === 1)
          && !edges.slice(i + 1, insertAt).some(next => next.gap && !next.bit && next.gap[1] >= end)) {
        edges.splice(insertAt, 0, { col: end, bit: 0 });
      }
    }
  }
  // A start shared by two verified frame boundaries explains another edge.
  const fraction = (included + frameStarts) / Math.max(1, edges.length - 1);
  const error = alignment / Math.max(1, included);
  // Observed stop samples still support a rate when the capture ends inside a stop bit.
  const frameWeight = good + (croppedStop ? 0.75 : 0);
  // Frames at different baud rates earn equal credit when they cover the same number of samples.
  const frameCoverage = frameWeight * px / MIN_PX_PER_BIT;
  const score = frameWeight > 0 ? 4 * frameWeight / frames.length + 2.5 * fraction
    - 7 * error - 3 * short / Math.max(1, included) + 2 * Math.log2(1 + frameCoverage) - 0.35 * bad : -Infinity;
  return { frames, score, good, edgeCoverage: fraction };
}

function pulseTiming(edges: readonly Edge[], px: number, frameBits: number) {
  let widths = 0, aligned = 0, single = 0;
  const tolerance = Math.max(0.18, 1.35 / px);
  for (let i = 1; i < edges.length; i++) {
    const before = edges[i - 1]!, after = edges[i]!;
    const bits = (after.col - before.col) / px;
    if (before.gap || after.gap || (before.bit === 1 && bits >= frameBits)) continue;
    widths++;
    const rounded = Math.round(bits);
    if (rounded >= 1 && Math.abs(bits - rounded) <= tolerance) {
      aligned++;
      if (rounded === 1) single++;
    }
  }
  return { alignment: widths ? aligned / widths : 1, singleFraction: single / Math.max(1, widths) };
}

export function decodeUart(result: ExtractionResult, options: UartOptions): UartDecodeResult {
  const { channel, baud = 'auto', dataBits = 8, parity = 'none', stopBits = 1, idleHigh = true } = options;
  const settings = { dataBits, parity, stopBits, idleHigh };
  const dt = columnInterval(result);
  const trace = result.traces.find(t => t.channel === channel && t.settings.enabled);
  const samples = columnSamples(result, samplesFor(result, channel));
  const values = samples.filter(valid).map(s => s.voltage).sort((a, b) => a - b);
  let lo = quantile(values, 0.005), hi = quantile(values, 0.995);
  const min = values[0] ?? NaN, max = values.at(-1) ?? NaN;
  const fullSwing = max - min;
  // A short start pulse in a long idle capture can fall outside the percentiles.
  const sparseRail = fullSwing > 2 * (hi - lo) && values.length >= 4
    && values[1]! <= min + 0.2 * fullSwing && values.at(-2)! >= max - 0.2 * fullSwing;
  const manualThreshold = options.thresholdVolts;
  if (sparseRail || (manualThreshold !== undefined && (manualThreshold <= lo || manualThreshold >= hi))) {
    lo = min;
    hi = max;
  }
  const swing = hi - lo;
  const threshold = manualThreshold ?? (lo / 2 + hi / 2);
  const thresholdVolts = Number.isFinite(threshold) ? threshold : null;
  const warnings: string[] = result.timebase.source === 'default' ? ['uncalibrated_timebase'] : [];
  const base = { channel, ...settings, thresholdVolts, warnings };
  const out = (reason: UartDecodeResult['reason'], rate: number | null, pxPerBit: number | null, frames: UartFrame[] = []): UartDecodeResult => {
    const rawText = frames.map(frame => frame.byte === null || frame.framingError || frame.parityError
      ? '\uFFFD' : String.fromCharCode(frame.byte)).join('');
    return { ...base, reason, baud: rate, pxPerBit, frames, rawText, text: rawText.replace(/[\r\n]+$/, '') };
  };
  const manual = typeof baud === 'number' && Number.isFinite(baud) && baud > 0 ? baud : null;
  if (!(dt > 0) || !Number.isFinite(dt) || (baud !== 'auto' && manual === null)) return out('baud_unresolved', manual, null);
  if (manual !== null && 1 / (manual * dt) < MIN_PX_PER_BIT - 1e-9) return out('insufficient_resolution', manual, 1 / (manual * dt));
  const step = (trace?.settings.voltsPerDiv ?? 0) / result.detection.grid.pxPerVDiv;
  if (thresholdVolts === null || !(swing > 0) || (options.thresholdVolts === undefined && swing < step * 3)
      || threshold <= lo || threshold >= hi) return out('insufficient_levels', manual, manual === null ? null : 1 / (manual * dt));
  if (manual === null) {
    const middle = values.filter(voltage => voltage >= lo + 0.2 * swing && voltage <= hi - 0.2 * swing).length;
    if (middle > 0.3 * values.length) return out('baud_unresolved', null, null);
  }
  const band = Math.min(swing * 0.11, (threshold - lo) / 2, (hi - threshold) / 2);
  const edges = findEdges(samples, threshold, band, idleHigh);
  const frameBits = 1 + dataBits + Number(parity !== 'none') + stopBits;
  const trial = (rate: number) => {
    const px = 1 / (rate * dt);
    const { alignment, singleFraction } = pulseTiming(edges, px, frameBits);
    const filtered: Edge[] = [];
    for (const edge of edges) {
      if (filtered.length && edge.col - filtered.at(-1)!.col < px * 0.27) filtered.pop();
      else filtered.push(edge);
    }
    let best = inspect(samples, [...filtered], px, threshold, dt, settings, 0);
    const first = filtered.findIndex(edge => !edge.bit);
    const beginsLow = samples[0] && valid(samples[0]) && (samples[0].voltage >= threshold) !== idleHigh;
    let partial = Boolean(beginsLow);
    if (first >= 0 && (beginsLow || filtered[first]!.col < 1.25 * px)) {
      for (let i = first + 1; i < filtered.length && filtered[i]!.col < (frameBits - 0.25) * px; i++) {
        if (filtered[i]!.bit || filtered[i]!.gap) continue;
        const candidate = inspect(samples, [...filtered], px, threshold, dt, settings, i);
        if (candidate.good > best.good) {
          best = candidate;
          partial = true;
        }
      }
    }
    const initialSpan = (best.frames[0]?.startSec ?? Infinity) - samples[0]!.timeSec;
    if (partial && initialSpan > 0 && initialSpan < frameBits * px * dt) {
      best.frames.unshift({
        startSec: samples[0]!.timeSec, endSec: best.frames[0]!.startSec,
        byte: null, hex: '', ascii: '', framingError: true, parityError: false, uncertain: true,
      });
    }
    const score = manual !== null ? best.score
      : alignment >= 0.75 ? best.score + 2 * singleFraction - 4 * (1 - alignment) : -Infinity;
    const fullyExplained = alignment === 1 && best.edgeCoverage >= 1 && best.good > 0
      && best.frames.length === best.good && best.frames.every(frame => !frame.uncertain);
    return { rate, px, frames: best.frames, good: best.good, score, singleFraction, fullyExplained };
  };
  const trials = manual === null
    ? STANDARD_UART_BAUDS.filter(rate => 1 / (rate * dt) >= 2).map(trial)
      .sort((a, b) => b.score - a.score || b.good - a.good)
    : [trial(manual)];
  const [best, ...alternatives] = trials;
  if (!best || (manual === null && !Number.isFinite(best.score))) return out('baud_unresolved', null, null);
  if (best.px < MIN_PX_PER_BIT - 1e-9) return out('insufficient_resolution', best.rate, best.px);
  if (best.fullyExplained && alternatives.some(other => other.px >= MIN_PX_PER_BIT - 1e-9 && other.fullyExplained
      && other.singleFraction === best.singleFraction && other.good !== best.good
      && Math.abs(other.frames[0]!.startSec - best.frames[0]!.startSec) <= dt
      && Math.abs(other.frames.at(-1)!.endSec - best.frames.at(-1)!.endSec) <= dt)) {
    warnings.push('baud_ambiguous');
  }
  if (best.px < 8 - 1e-9) warnings.push('low_resolution');
  if (best.frames.some(frame => frame.uncertain)) warnings.push('uncertain_frames');
  if (best.frames.some(frame => frame.framingError)) warnings.push('framing_errors');
  if (best.frames.some(frame => frame.parityError)) warnings.push('parity_errors');
  return out(best.frames.length ? null : 'no_frames', best.rate, best.px, best.frames);
}
