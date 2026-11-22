import { analyzeBodeBatch as fitBatch } from './bode.js';
import type { BodeOverrides } from './bode.js';
import { extractTraces, makeTimebase } from './extract.js';
import { buildOverlayMask } from './mask.js';
import { compareScope, measureChannel, measurePhase, scopeFrequency } from './measurements.js';
import { readScopeMetadata } from './ocr.js';
import { decodePng } from './png.js';
import { detectProfile } from './profiles.js';
import type { BodeGateOptions, BodeResult, ExtractionOverrides, ExtractionResult, RgbaImage } from './types.js';

export { recomputeBodeResult } from './bode.js';
export type { BodeOverrides } from './bode.js';

export function analyzeCapture(image: RgbaImage, fileName: string, overrides: ExtractionOverrides = {}): ExtractionResult {
  const start = performance.now();
  const detection = detectProfile(image, overrides);
  const metadata = readScopeMetadata(image, detection);
  const timebase = makeTimebase(metadata, overrides);
  const { scopeReadings, topFrequencyHz, topFrequencyRaw } = metadata;
  const mask = buildOverlayMask(image, detection.grid, detection.profileId);
  const { traces, warnings } = extractTraces(image, detection, metadata, mask, timebase, overrides);
  const measurements = traces.map(trace => measureChannel(trace, detection.grid.pxPerVDiv));
  const referenceFrequency = scopeFrequency(scopeReadings, 'C1', topFrequencyHz, topFrequencyRaw)
    ?? measurements.find(measurement => measurement.channel === 'C1')?.frequencyHz ?? null;
  return {
    fileName, imageWidth: image.width, imageHeight: image.height,
    detection: warnings.length ? { ...detection, warnings: [...detection.warnings, ...warnings] } : detection,
    timebase, topFrequencyHz, topFrequencyRaw, traces,
    measurements, phaseC1ToC2: measurePhase(traces, timebase.source === 'default' ? null : referenceFrequency), scopeReadings,
    comparisons: compareScope(scopeReadings, measurements, traces, topFrequencyHz, topFrequencyRaw),
    maskCoveragePct: mask.coveragePct, elapsedMs: performance.now() - start,
  };
}

export function analyzePngBytes(bytes: Uint8Array, fileName: string, overrides?: ExtractionOverrides): ExtractionResult {
  const start = performance.now();
  const result = analyzeCapture(decodePng(bytes), fileName, overrides);
  return { ...result, elapsedMs: performance.now() - start };
}

export interface BodeCaptureInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly overrides?: ExtractionOverrides;
}

export function analyzeBodeBatch(captures: readonly (BodeCaptureInput | ExtractionResult)[], options?: BodeGateOptions,
  overrides?: BodeOverrides): BodeResult {
  const start = performance.now();
  const extractions = captures.map(capture => 'bytes' in capture ? analyzePngBytes(capture.bytes, capture.fileName, capture.overrides) : capture);
  return { ...fitBatch(extractions, options, overrides), elapsedMs: performance.now() - start };
}
