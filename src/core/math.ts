import { columnSamples, isClipped, sampleStatus } from './columns.js';
import { scaleOffset, valid } from './dsp.js';
import { stepScale125 } from './export/format.js';
import { measureChannel } from './measurements.js';
import type { ChannelTrace, ExtractionResult, GapStatus, MathConfig, MathTraceResult, TraceSample } from './types.js';

export type { MathConfig, MathOp, MathTraceResult } from './types.js';

const faultPriority: Readonly<Record<GapStatus, number>> = {
  ok: 0, unresolved: 1, masked_overlay: 2, masked_cursor: 3, overlap_ambiguous: 4, clipped_low: 5, clipped_high: 5,
};

function invertClip(status: GapStatus): GapStatus {
  return status === 'clipped_high' ? 'clipped_low' : status === 'clipped_low' ? 'clipped_high' : status;
}

function scale125(minimum: number): number {
  if (!(minimum > 0) || !Number.isFinite(minimum)) return 1;
  const below = stepScale125(minimum, -1);
  const above = stepScale125(below, 1);
  return above >= minimum * (1 - 1e-10) ? above : Math.max(minimum, stepScale125(above, 1));
}

export function computeMathTrace(result: ExtractionResult, config: MathConfig): MathTraceResult | null {
  const a = result.traces.find(trace => trace.channel === config.a && trace.settings.enabled);
  const b = result.traces.find(trace => trace.channel === config.b && trace.settings.enabled);
  if (!a || !b) return null;
  const grid = result.detection.grid;
  const dvA = a.settings.voltsPerDiv / grid.pxPerVDiv, dvB = b.settings.voltsPerDiv / grid.pxPerVDiv;
  const multiply = config.op === 'mul';
  let pixelVoltage = multiply ? dvA * dvB : Math.hypot(dvA, dvB);
  let min = Infinity, max = -Infinity, aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
  const bs = columnSamples(result, b.samples);
  const raw = columnSamples(result, a.samples).map((x, col): TraceSample => {
    const y = bs[col]!;
    if (valid(x) && valid(y)) {
      const voltage = multiply ? x.voltage * y.voltage : config.op === 'add' ? x.voltage + y.voltage : x.voltage - y.voltage;
      if (Number.isFinite(voltage)) {
        min = Math.min(min, voltage); max = Math.max(max, voltage);
        aMin = Math.min(aMin, x.voltage); aMax = Math.max(aMax, x.voltage);
        bMin = Math.min(bMin, y.voltage); bMax = Math.max(bMax, y.voltage);
        if (multiply) pixelVoltage = Math.max(pixelVoltage, Math.hypot(y.voltage * dvA, x.voltage * dvB, dvA * dvB));
        return { ...x, yPx: null, voltage };
      }
    }
    const sx = sampleStatus(x), sy = sampleStatus(y);
    const aStatus = multiply && valid(y) && y.voltage < 0 ? invertClip(sx) : sx;
    const bStatus = config.op === 'sub' || (multiply && valid(x) && x.voltage < 0) ? invertClip(sy) : sy;
    const fault = faultPriority[aStatus] >= faultPriority[bStatus] ? aStatus : bStatus;
    return { ...x, yPx: null, voltage: null, status: fault === 'ok' ? 'unresolved' : fault };
  });
  const swing = max - min;
  const halfDivisions = grid.vDivs * 0.4;
  const minimumScale = Math.max((max / 2 - min / 2) / halfDivisions, (pixelVoltage / halfDivisions) * 2);
  const voltsPerDiv = Number.isFinite(config.voltsPerDiv) && config.voltsPerDiv! > 0 ? config.voltsPerDiv!
    : scale125(Math.min(Number.MAX_VALUE, minimumScale));
  const center = Number.isFinite(min) ? min / 2 + max / 2 : 0;
  const offsetStep = voltsPerDiv / 10;
  const roundedOffset = Math.round(center / offsetStep) * offsetStep;
  const offsetVolts = Number.isFinite(config.offsetVolts) ? config.offsetVolts!
    : Number.isFinite(roundedOffset) ? roundedOffset || 0 : center;
  const samples = raw.map(sample => {
    if (!valid(sample)) return sample;
    const difference = sample.voltage - offsetVolts;
    const pixels = Number.isFinite(difference) ? scaleOffset(difference, voltsPerDiv, grid.pxPerVDiv)
      : scaleOffset(sample.voltage / 2 - offsetVolts / 2, voltsPerDiv, grid.pxPerVDiv) * 2;
    return { ...sample, yPx: Number.isFinite(pixels) ? grid.centerY - pixels : null };
  });
  const validCount = samples.filter(valid).length;
  const clippedCount = samples.filter(sample => isClipped(sample.status)).length;
  const trace: ChannelTrace = {
    ...a, settings: { ...a.settings, voltsPerDiv, offsetVolts }, samples, validCount, clippedCount,
  };
  const warnings: string[] = [];
  if (!multiply && Math.max(dvA, dvB) >= 10 * Math.min(dvA, dvB)) warnings.push('mismatched_math_scale');
  const sourceSwing = Math.max(aMax - aMin, bMax - bMin);
  const lowSwing = validCount > 0 && (swing <= 4 * pixelVoltage || (!multiply && swing <= sourceSwing * 0.05));
  if (lowSwing) warnings.push('math_low_swing');
  const measurement = measureChannel(trace, grid.pxPerVDiv, lowSwing ? Math.max(pixelVoltage, swing) : pixelVoltage);
  return {
    config, unit: multiply ? 'V²' : 'V', label: config.label?.trim() || 'M',
    samples, voltsPerDiv, offsetVolts, validCount, gapCount: samples.length - validCount, measurement, warnings,
  };
}
