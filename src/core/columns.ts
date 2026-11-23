import type { ExtractionResult, GapStatus, MathTraceResult, TraceSample, XyAxisId } from './types.js';
import { valid } from './dsp.js';

export const columnInterval = (result: ExtractionResult) => result.timebase.secPerDiv / result.detection.grid.pxPerHDiv;

export function samplesFor(result: ExtractionResult, axis: XyAxisId, math?: MathTraceResult | null): readonly TraceSample[] {
  return axis === 'M' ? math?.samples ?? []
    : result.traces.find(trace => trace.channel === axis && trace.settings.enabled)?.samples ?? [];
}

export function columnSamples(result: ExtractionResult, samples: readonly TraceSample[]): TraceSample[] {
  const map = new Map(samples.map(sample => [sample.col, sample]));
  const { width, left, centerX } = result.detection.grid;
  const dt = columnInterval(result);
  return Array.from({ length: width + 1 }, (_, col) => map.get(col) ?? {
    col, xPx: left + col, yPx: null, voltage: null, status: 'unresolved',
    timeSec: (left + col - centerX) * dt + result.timebase.triggerOffsetSec,
  });
}

export function sampleStatus(sample: TraceSample): GapStatus {
  return sample.status === 'ok' && !valid(sample) ? 'unresolved' : sample.status;
}

export const isClipped = (status: GapStatus) => status === 'clipped_high' || status === 'clipped_low';
