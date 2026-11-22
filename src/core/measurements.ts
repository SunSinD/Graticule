import { fitShared, median, quantile, valid, wrapPhase } from './dsp.js';
import type { ChannelMeasurements, ChannelTrace, PhaseMeasurement, ScopeComparisonRow, ScopeMeasureReading, TraceSample } from './types.js';

interface Transition { readonly rising: boolean; readonly time: number; readonly segment: number }
interface ObservedSpan { readonly start: number; end: number }

function schmittCrossings(samples: readonly TraceSample[], mid: number, hysteresis: number): {
  events: Transition[]; spans: ObservedSpan[];
} {
  const events: Transition[] = [];
  const spans: ObservedSpan[] = [];
  let state: 'high' | 'low' | null = null;
  let previous: (TraceSample & { readonly voltage: number }) | null = null;
  let midpoint: number | null = null;
  let segment = 0;
  let missed = 0;
  for (const sample of samples) {
    if (!valid(sample)) {
      missed++;
      continue;
    }
    if (missed > 4) {
      if (missed > 24) segment++;
      if (missed > 24 || !previous || (previous.voltage < mid) !== (sample.voltage < mid)) {
        midpoint = null;
        state = null;
      }
      previous = null;
    }
    missed = 0;
    const span = spans[segment] ??= { start: sample.timeSec, end: sample.timeSec };
    span.end = sample.timeSec;
    if (previous && ((previous.voltage < mid && sample.voltage >= mid) || (previous.voltage > mid && sample.voltage <= mid))) {
      midpoint = previous.timeSec + (sample.timeSec - previous.timeSec) * (mid - previous.voltage) / (sample.voltage - previous.voltage);
    }
    const next = sample.voltage >= mid + hysteresis ? 'high' : sample.voltage <= mid - hysteresis ? 'low' : null;
    if (next && next !== state) {
      if (state && midpoint !== null) events.push({ rising: next === 'high', time: midpoint, segment });
      state = next;
      midpoint = null;
    }
    previous = sample;
  }
  return { events, spans };
}

function cycleTimes(events: readonly Transition[], rising: boolean): { period: number; on: number | null; segment: number }[] {
  const cycles: { period: number; on: number | null; segment: number }[] = [];
  let edge: Transition | null = null;
  let opposite: Transition | null = null;
  for (const event of events) {
    if (event.rising !== rising) {
      opposite = event;
      continue;
    }
    if (edge?.segment === event.segment && event.time > edge.time) {
      cycles.push({ period: event.time - edge.time, segment: event.segment, on: opposite?.segment === event.segment
        && opposite.time > edge.time ? (rising ? opposite.time - edge.time : event.time - opposite.time) : null });
    }
    edge = event;
  }
  return cycles;
}

export function measureChannel(trace: ChannelTrace, pxPerVDiv: number): ChannelMeasurements {
  const values = trace.samples.filter(valid).map(s => s.voltage).sort((a, b) => a - b);
  const vmin = values[0] ?? null;
  const vmax = values.at(-1) ?? null;
  const low = quantile(values, 0.05);
  const high = quantile(values, 0.95);
  const amplitude = high - low;
  const mid = (high + low) / 2;
  const minimumAmplitude = 4 * trace.settings.voltsPerDiv / pxPerVDiv;
  const { events, spans } = amplitude >= minimumAmplitude ? schmittCrossings(trace.samples, mid, amplitude * 0.25)
    : { events: [], spans: [] };
  const rises = cycleTimes(events, true);
  const falls = cycleTimes(events, false);
  const sampleInterval = (trace.samples[1]?.timeSec ?? 0) - (trace.samples[0]?.timeSec ?? 0);
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
  const middleCount = values.filter(v => Math.abs(v - mid) < amplitude * 0.31).length;
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
  const singleCycleSpan = cycles.length === 1 ? spans[cycles[0]!.segment] : undefined;
  const enoughObservation = confirmed.length >= 2 || (singleCycleSpan
    && singleCycleSpan.end - singleCycleSpan.start >= typical * 1.5);
  const periodSec = enoughObservation && confirmed.length >= periods.length * 0.75
    && longestHold <= typical * 1.25 && stableDuty ? median(confirmed) : null;
  const completeCycles = periodSec === null ? 0 : Math.max(rises.filter(plausible).length, falls.filter(plausible).length);
  return {
    channel: trace.channel, vmax, vmin, vpp: vmax !== null && vmin !== null ? vmax - vmin : null,
    vavg: values.length ? values.reduce((s, v) => s + v, 0) / values.length : null,
    vrms: values.length ? Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length) : null,
    periodSec, frequencyHz: periodSec !== null ? 1 / periodSec : null,
    dutyCyclePct: periodSec !== null && pulseLike && completeCycles >= 2 && duty.length >= 2 ? median(duty) : null,
    completeCycles, clipped: trace.clippedCount > 0,
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
    : !fit.input || !fit.output || fit.cycles < 1 ? 'insufficient_shared_samples'
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
