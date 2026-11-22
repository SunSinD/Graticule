import { fitShared, median, quantile, valid, wrapPhase } from './dsp.js';
import type { ChannelMeasurements, ChannelTrace, PhaseMeasurement, ScopeComparisonRow, ScopeMeasureReading, TraceSample } from './types.js';

interface Transition { readonly rising: boolean; readonly time: number; readonly segment: number }
interface ObservedSpan { readonly start: number; end: number; readonly stepInto: 'rise' | 'fall' | null }
type VoltageSample = TraceSample & { readonly voltage: number };

function crossing(previous: VoltageSample, current: VoltageSample, level: number): number {
  return previous.timeSec + (current.timeSec - previous.timeSec) * (level - previous.voltage) / (current.voltage - previous.voltage);
}

function smoothCrossing(samples: readonly TraceSample[], index: number, mid: number, band: number): number {
  const current = samples[index] as VoltageSample;
  const previous = samples[index - 1] as VoltageSample;
  const linear = crossing(previous, current, mid);
  const center = Math.abs(current.voltage - mid) < Math.abs(previous.voltage - mid) ? index : index - 1;
  const pivot = samples[center]!;
  const radius = 3;
  let sumT = 0, sumV = 0, sumTT = 0, sumTV = 0;
  for (let i = -radius; i <= radius; i++) {
    const sample = samples[center + i];
    if (!sample || !valid(sample) || sample.col !== pivot.col + i || Math.abs(sample.voltage - mid) > band) return linear;
    const time = sample.timeSec - pivot.timeSec;
    const voltage = sample.voltage - mid;
    sumT += time;
    sumV += voltage;
    sumTT += time * time;
    sumTV += time * voltage;
  }
  const count = 2 * radius + 1;
  const slope = (sumTV - sumT * sumV / count) / (sumTT - sumT ** 2 / count);
  const smoothed = pivot.timeSec + (sumT - sumV / slope) / count;
  const dt = current.timeSec - previous.timeSec;
  return Math.abs(smoothed - linear) <= dt ? smoothed : linear;
}

function schmittCrossings(samples: readonly TraceSample[], mid: number, hysteresis: number): {
  events: Transition[]; spans: ObservedSpan[];
} {
  const events: Transition[] = [];
  const spans: ObservedSpan[] = [];
  let state: 'high' | 'low' | null = null;
  let previous: VoltageSample | null = null;
  let lastObserved: VoltageSample | null = null;
  let midpoint: number | null = null;
  let segment = 0;
  for (const [index, sample] of samples.entries()) {
    if (previous && (!valid(sample) || sample.col !== previous.col + 1 || sample.timeSec <= previous.timeSec)) {
      segment++;
      midpoint = null;
      state = null;
      previous = null;
    }
    if (!valid(sample)) continue;
    if (!spans[segment]) {
      let stepInto: ObservedSpan['stepInto'] = null;
      const hidden = samples[index - 1];
      if (lastObserved && hidden && sample.col === lastObserved.col + 2 && hidden.col === sample.col - 1
          && (hidden.status === 'unresolved' || hidden.status === 'masked_cursor' || hidden.status === 'masked_overlay')) {
        if (lastObserved.voltage <= mid - hysteresis && sample.voltage >= mid + hysteresis) stepInto = 'rise';
        if (lastObserved.voltage >= mid + hysteresis && sample.voltage <= mid - hysteresis) stepInto = 'fall';
      }
      spans[segment] = { start: sample.timeSec, end: sample.timeSec, stepInto };
    }
    const span = spans[segment]!;
    span.end = sample.timeSec;
    if (previous && ((previous.voltage < mid && sample.voltage >= mid) || (previous.voltage > mid && sample.voltage <= mid))) {
      midpoint = smoothCrossing(samples, index, mid, hysteresis);
    }
    const next = sample.voltage >= mid + hysteresis ? 'high' : sample.voltage <= mid - hysteresis ? 'low' : null;
    if (next && next !== state) {
      if (state && midpoint !== null) events.push({ rising: next === 'high', time: midpoint, segment });
      state = next;
      midpoint = null;
    }
    previous = sample;
    lastObserved = sample;
  }
  return { events, spans };
}

function cycleTimes(events: readonly Transition[], spans: readonly ObservedSpan[], rising: boolean):
  { period: number; on: number | null; segment: number }[] {
  const cycles: { period: number; on: number | null; segment: number }[] = [];
  let edge: Transition | null = null;
  let opposite: Transition | null = null;
  for (const event of events) {
    if (event.rising !== rising) {
      opposite = event;
      continue;
    }
    if (edge && event.time > edge.time) {
      const visibleOpposite = opposite && opposite.time > edge.time ? opposite : null;
      if (edge.segment === event.segment && visibleOpposite?.segment === event.segment) {
        cycles.push({ period: event.time - edge.time, segment: event.segment,
          on: rising ? visibleOpposite.time - edge.time : event.time - visibleOpposite.time });
      // One obscured column between opposite plateaus can conceal a return edge, but cannot
      // conceal a complete cycle at the minimum measurable period. Its time is unknown.
      } else if (edge.segment + 1 === event.segment && !visibleOpposite
          && spans[event.segment]!.stepInto === (rising ? 'fall' : 'rise')) {
        cycles.push({ period: event.time - edge.time, segment: event.segment, on: null });
      }
    }
    edge = event;
  }
  return cycles;
}

function waveformLevels(values: readonly number[], minimumAmplitude: number): readonly [number, number] {
  const low = quantile(values, 0.05);
  const high = quantile(values, 0.95);
  const span = (values.at(-1) ?? 0) - (values[0] ?? 0);
  if (!(span >= minimumAmplitude) || high - low >= span * 0.6) return [low, high];

  // Search the tails for recurrent levels that are too rare for the 5th and 95th percentiles.
  const binWidth = Math.max(span / 128, minimumAmplitude / 4);
  const min = values[0]!;
  const bins: number[][] = Array.from({ length: 129 }, () => []);
  for (const value of values) bins[Math.min(128, Math.floor((value - min) / binWidth))]!.push(value);
  const count = Math.max(3, Math.ceil(values.length * 0.005));
  const tail = (order: readonly number[][]) => {
    for (let i = 0; i < order.length; i++) {
      const nearby = [...order[i]!, ...(order[i + 1] ?? [])];
      if (nearby.length >= count) return median(nearby.sort((a, b) => a - b));
    }
    return NaN;
  };
  const tailLow = tail(bins);
  const tailHigh = tail(bins.reverse());
  return tailHigh - tailLow > high - low ? [tailLow, tailHigh] : [low, high];
}

interface Plateau { start: number; end: number; readonly anchor: number }
interface StableLevel extends Plateau { duration: number; voltage: number }
interface Edge { readonly duration: number; readonly overshoot: number | null }
type EdgeMetrics = Pick<ChannelMeasurements, 'riseTimeSec' | 'fallTimeSec' | 'overshootPct' | 'riseLimited' | 'fallLimited'>;

function measureEdges(samples: readonly TraceSample[], pixelVoltage: number, span: number, sampleInterval: number): EdgeMetrics {
  const rises: Edge[] = [];
  const falls: Edge[] = [];
  const window = 3;
  const tolerance = Math.max(pixelVoltage * 1.5, span * 0.02);

  function inspect(segment: readonly VoltageSample[]) {
    const plateaus: Plateau[] = [];
    for (let i = 0; i <= segment.length - window; i++) {
      const levels = segment.slice(i, i + window).map(sample => sample.voltage).sort((a, b) => a - b);
      const center = median(levels);
      if (levels[window - 1]! - levels[0]! > tolerance / 2) continue;
      const last = plateaus.at(-1);
      if (last && i <= last.end && Math.abs(center - last.anchor) <= tolerance / 2) last.end = i + window - 1;
      else if (!last || i > last.end) plateaus.push({ start: i, end: i + window - 1, anchor: center });
    }
    const levels: StableLevel[] = [];
    for (const plateau of plateaus) {
      const { start, end } = plateau;
      const voltage = median(segment.slice(start, end + 1).map(s => s.voltage).sort((a, b) => a - b));
      const duration = segment[end]!.timeSec - segment[start]!.timeSec;
      const last = levels.at(-1);
      const nearby = last && Math.abs(voltage - last.voltage) <= span * 0.2
        && segment.slice(last.end + 1, start).every(sample =>
          Math.abs(sample.voltage - voltage) <= span * 0.3 && Math.abs(sample.voltage - last.voltage) <= span * 0.3);
      if (last && nearby) {
        last.end = end;
        if (duration > last.duration) {
          last.start = start;
          last.duration = duration;
          last.voltage = voltage;
        }
      } else {
        levels.push({ ...plateau, duration, voltage });
      }
    }
    for (let i = 1; i < levels.length; i++) {
      const before = levels[i - 1]!;
      let after = levels[i]!;
      const start = before.voltage;
      const initialChange = after.voltage - start;
      const minChange = Math.max(4 * pixelVoltage, span * 0.25);
      if (Math.abs(initialChange) < minChange) continue;
      // A short dwell near a ringing peak can look like a plateau. Prefer a longer
      // settled dwell while the signal remains on the same side of the starting level.
      for (let k = i + 1; k < levels.length; k++) {
        const candidate = levels[k]!;
        const fraction = (candidate.voltage - start) / initialChange;
        if (fraction < 0.4 || (fraction - 1) * Math.abs(initialChange) > span * 0.55
            || segment.slice(levels[k - 1]!.end + 1, candidate.start)
              .some(sample => (sample.voltage - start) / initialChange < 0.3)) break;
        if (candidate.duration > after.duration * 1.5) after = candidate;
      }
      const change = after.voltage - start;
      if (Math.abs(change) < minChange) continue;
      let t10: number | null = null;
      let t90: number | null = null;
      let extreme = 1;
      for (let j = before.end; j <= Math.min(after.start + window - 1, after.end); j++) {
        const a = segment[j - 1]!;
        const b = segment[j]!;
        const f1 = (a.voltage - start) / change;
        const f2 = (b.voltage - start) / change;
        if (t90 === null) {
          if (f1 < 0.1 && f2 >= 0.1) t10 = crossing(a, b, start + change * 0.1);
          if (t10 !== null && f1 < 0.9 && f2 >= 0.9) t90 = crossing(a, b, start + change * 0.9);
        }
        if (t90 !== null) extreme = Math.max(extreme, f2);
      }
      if (t10 === null || t90 === null) continue;
      const duration = t90 - t10;
      // Quantized slopes can form short plateaus. A step spends longer at each level than in transition.
      if (duration <= 0 || Math.min(before.duration, after.duration) < duration) continue;
      const overshoot = 100 * Math.max(0, extreme - 1);
      (change > 0 ? rises : falls).push({ duration, overshoot: change > 0 ? overshoot : null });
      i = levels.indexOf(after, i);
    }
  }

  if (span >= 4 * pixelVoltage && sampleInterval > 0) {
    let segment: VoltageSample[] = [];
    for (const sample of samples) {
      const last = segment.at(-1);
      if (last && (!valid(sample) || sample.col !== last.col + 1 || sample.timeSec <= last.timeSec)) {
        inspect(segment);
        segment = [];
      }
      if (valid(sample)) segment.push(sample);
    }
    inspect(segment);
  }
  const rise = median(rises.map(edge => edge.duration).sort((a, b) => a - b));
  const fall = median(falls.map(edge => edge.duration).sort((a, b) => a - b));
  const overshoot = median(rises.flatMap(edge => edge.overshoot === null ? [] : [edge.overshoot]).sort((a, b) => a - b));
  const floor = 2 * sampleInterval;
  return {
    riseTimeSec: Number.isFinite(rise) ? Math.max(floor, rise) : null,
    fallTimeSec: Number.isFinite(fall) ? Math.max(floor, fall) : null,
    overshootPct: Number.isFinite(overshoot) ? overshoot : null,
    riseLimited: rise < floor * (1 - 1e-9), fallLimited: fall < floor * (1 - 1e-9),
  };
}

export function measureChannel(trace: ChannelTrace, pxPerVDiv: number): ChannelMeasurements {
  const values = trace.samples.filter(valid).map(s => s.voltage).sort((a, b) => a - b);
  const vmin = values[0] ?? null;
  const vmax = values.at(-1) ?? null;
  const peak = Math.max(Math.abs(vmin ?? 0), Math.abs(vmax ?? 0));
  const scale = peak > Math.sqrt(Number.MAX_VALUE) ? peak : 1;
  const levels = scale === 1 ? values : values.map(value => value / scale);
  const samples = scale === 1 ? trace.samples : trace.samples.map(sample => valid(sample) ? { ...sample, voltage: sample.voltage / scale } : sample);
  const pixelVoltage = trace.settings.voltsPerDiv / scale / pxPerVDiv;
  const minimumAmplitude = 4 * pixelVoltage;
  const [low, high] = waveformLevels(levels, minimumAmplitude);
  const amplitude = high - low;
  const mid = low + amplitude / 2;
  const { events, spans } = amplitude > 0 && amplitude >= minimumAmplitude ? schmittCrossings(samples, mid, amplitude * 0.25)
    : { events: [], spans: [] };
  const rises = cycleTimes(events, spans, true);
  const falls = cycleTimes(events, spans, false);
  const first = trace.samples[0];
  const last = trace.samples.at(-1);
  const sampleInterval = first && last && last.col > first.col ? (last.timeSec - first.timeSec) / (last.col - first.col) : 0;
  const longEnough = ({ period }: { period: number }) => period >= sampleInterval * 6;
  const cycles = [...rises, ...falls].filter(longEnough);
  const periods = cycles.map(cycle => cycle.period).sort((a, b) => a - b);
  const typical = median(periods);
  const closeToTypical = (period: number) => Math.abs(period / typical - 1) <= 0.2;
  const plausible = (cycle: { period: number }) => longEnough(cycle) && closeToTypical(cycle.period);
  const confirmed = periods.filter(closeToTypical);
  const duty = [...rises, ...falls]
    .flatMap(c => c.on !== null && plausible(c) && c.on > 0 && c.on < c.period ? [100 * c.on / c.period] : [])
    .sort((a, b) => a - b);
  const middleCount = levels.filter(v => Math.abs(v - mid) < amplitude * 0.31).length;
  const pulseLike = values.length > 0 && middleCount / values.length <= 0.18;
  // A burst can have several regular edge spacings inside a much longer idle interval.
  const longestHold = events.reduce((longest, event, index) => {
    const before = events[index - 1];
    const after = events[index + 1];
    const span = spans[event.segment]!;
    const start = before?.segment === event.segment ? before.time : span.start;
    const end = after?.segment === event.segment ? after.time : span.end;
    return Math.max(longest, event.time - start, end - event.time);
  }, 0);
  const stableDuty = !pulseLike || duty.length < 2 || quantile(duty, 0.9) - quantile(duty, 0.1) <= 20;
  const singleCycleSpan = cycles.length === 1 && cycles[0]!.on !== null ? spans[cycles[0]!.segment] : undefined;
  const enoughObservation = confirmed.length >= 2 || (singleCycleSpan
    && singleCycleSpan.end - singleCycleSpan.start >= typical * 1.5);
  const periodSec = enoughObservation && confirmed.length >= periods.length * 0.75
    && longestHold <= typical * 1.25 && stableDuty ? median(confirmed) : null;
  const completeCycles = periodSec === null ? 0 : Math.max(rises.filter(plausible).length, falls.filter(plausible).length);
  const span = (vmax ?? 0) - (vmin ?? 0);
  const ratios = peak > 0 ? values.map(value => value / peak) : values;
  const mean = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  const meanSquare = ratios.reduce((sum, ratio) => sum + ratio ** 2, 0) / ratios.length;
  return {
    channel: trace.channel, vmax, vmin, vpp: values.length && Number.isFinite(span) ? span : null,
    vavg: values.length ? peak * mean : null,
    vrms: values.length ? peak * Math.sqrt(meanSquare) : null,
    periodSec, frequencyHz: periodSec !== null ? 1 / periodSec : null,
    dutyCyclePct: periodSec !== null && pulseLike && completeCycles >= 2 && duty.length >= 2 ? median(duty) : null,
    completeCycles, clipped: trace.clippedCount > 0,
    ...measureEdges(samples, pixelVoltage, (levels.at(-1) ?? 0) - (levels[0] ?? 0), sampleInterval),
  };
}

export function scopeFrequency(readings: readonly ScopeMeasureReading[], channel: ChannelTrace['channel'],
  topFrequencyHz: number | null, topFrequencyRaw: string | null): number | null {
  const scope = readings.find(reading => reading.channel === channel && reading.metric === 'freq' && (reading.value ?? 0) > 0);
  return scope?.value ?? (topFrequencyRaw?.replace(/\s+/g, '').startsWith(`f(${channel})=`) ? topFrequencyHz : null);
}

export function measurePhase(traces: readonly ChannelTrace[], frequencyHz: number | null): PhaseMeasurement | null {
  const ref = traces.find(trace => trace.channel === 'C1');
  const target = traces.find(trace => trace.channel === 'C2');
  if (!ref || !target) return null;
  const fit = frequencyHz ? fitShared(ref, target, frequencyHz) : null;
  const reason = !fit ? 'frequency_unconfirmed'
    : !fit.sufficientCoverage || !fit.input || !fit.output ? 'insufficient_shared_samples'
      : fit.input.r2 < 0.85 || fit.output.r2 < 0.85 ? 'poor_sine_fit' : null;
  return {
    refChannel: 'C1', targetChannel: 'C2',
    phaseDeg: reason === null && fit?.input && fit.output ? wrapPhase(fit.output.phaseDeg - fit.input.phaseDeg) : null,
    frequencyHz, r2Ref: fit?.input?.r2 ?? null, r2Target: fit?.output?.r2 ?? null,
    completeCycles: Math.floor(fit?.cycles ?? 0), reason,
  };
}

function computedFor(reading: ScopeMeasureReading, measurement: ChannelMeasurements | undefined,
  trace: ChannelTrace | undefined): number | null {
  if (!measurement) return null;
  switch (reading.metric) {
    case 'vpp': return measurement.vpp;
    case 'vmax': return measurement.vmax;
    case 'vmin': return measurement.vmin;
    case 'vavg': return measurement.vavg;
    case 'vrms': return measurement.vrms;
    case 'freq': return measurement.frequencyHz;
    case 'period': return measurement.periodSec;
    case 'duty': return measurement.dutyCyclePct;
    case 'amplitude': {
      const values = trace?.samples.filter(valid).map(s => s.voltage).sort((a, b) => a - b) ?? [];
      return values.length ? quantile(values, 0.95) - quantile(values, 0.05) : null;
    }
    default: return null;
  }
}

const baseUnits: Partial<Record<ScopeMeasureReading['metric'], string>> = {
  vpp: 'V', vmax: 'V', vmin: 'V', vavg: 'V', vrms: 'V', amplitude: 'V', freq: 'Hz', period: 's', duty: '%',
};

export function compareScope(readings: readonly ScopeMeasureReading[], measurements: readonly ChannelMeasurements[],
  traces: readonly ChannelTrace[], topFrequencyHz: number | null, topFrequencyRaw: string | null): ScopeComparisonRow[] {
  const all = [...readings];
  const topChannel = /^f\((C[1-4])\)=/.exec(topFrequencyRaw ?? '')?.[1] as ScopeMeasureReading['channel'] | undefined;
  if (topFrequencyHz !== null && topChannel && !readings.some(r => r.metric === 'freq' && r.channel === topChannel && r.value !== null)) {
    all.push({ label: `f(${topChannel})`, metric: 'freq', channel: topChannel, rawText: topFrequencyRaw ?? '', value: topFrequencyHz, unit: 'Hz' });
  }
  return all.flatMap(reading => {
    if (reading.value === null) return [];
    const graticuleValue = computedFor(reading, measurements.find(m => m.channel === reading.channel),
      traces.find(t => t.channel === reading.channel));
    const delta = graticuleValue === null ? null : graticuleValue - reading.value;
    return [{
      channel: reading.channel, metric: reading.metric === 'other' ? reading.label : reading.metric,
      unit: baseUnits[reading.metric] ?? reading.unit, scopeValue: reading.value,
      graticuleValue, delta, deltaPct: delta === null || reading.value === 0 ? null : delta / Math.abs(reading.value) * 100,
    }];
  });
}
