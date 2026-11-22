import { analyzeBodeBatch as fitBatch } from './bode.js';
import type { BodeOverrides } from './bode.js';
import { rectifyGrid } from './deskew.js';
import { extractTraces, makeTimebase } from './extract.js';
import { buildOverlayMask } from './mask.js';
import { compareScope, measureChannel, measurePhase, scopeFrequency } from './measurements.js';
import { readScopeMetadata } from './ocr.js';
import { decodePng } from './png.js';
import { detectProfile, getNativeProfile } from './profiles.js';
import type { BodeGateOptions, BodeRejectedCapture, BodeResult, ExtractionOverrides, ExtractionResult, RgbaImage } from './types.js';

export { recomputeBodeResult } from './bode.js';
export type { BodeOverrides } from './bode.js';

export function analyzeCapture(source: RgbaImage, fileName: string, overrides: ExtractionOverrides = {}): ExtractionResult {
  const start = performance.now();
  const quad = overrides.manualQuad;
  const image = quad ? rectifyGrid(source, quad) : source;
  const nativeGrid = quad && overrides.profileId ? getNativeProfile(overrides.profileId)?.graticule : undefined;
  const detection = detectProfile(image, quad ? {
    ...overrides, profileId: 'universal-fallback',
    hDivs: overrides.hDivs ?? nativeGrid?.hDivs, vDivs: overrides.vDivs ?? nativeGrid?.vDivs,
    manualCrop: { x: 0, y: 0, width: image.width - 1, height: image.height - 1 },
  } : overrides);
  const metadata = readScopeMetadata(image, detection);
  const timebase = makeTimebase(metadata, overrides, detection.grid.hDivs);
  const { scopeReadings, topFrequencyHz, topFrequencyRaw } = metadata;
  const mask = buildOverlayMask(image, detection.grid, detection.profileId);
  const { traces, warnings } = extractTraces(image, detection, metadata, mask, timebase, overrides);
  const measurements = traces.map(trace => measureChannel(trace, detection.grid.pxPerVDiv));
  const referenceFrequency = scopeFrequency(scopeReadings, 'C1', topFrequencyHz, topFrequencyRaw)
    ?? measurements.find(measurement => measurement.channel === 'C1')?.frequencyHz ?? null;
  return {
    fileName, imageWidth: image.width, imageHeight: image.height,
    ...(quad && { sourceWidth: source.width, sourceHeight: source.height, sourceQuad: quad }),
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

export function analyzeBodeBatch(captures: readonly (BodeCaptureInput | ExtractionResult | BodeRejectedCapture)[], options?: BodeGateOptions,
  overrides?: BodeOverrides): BodeResult {
  const start = performance.now();
  const extractions = captures.map(capture => 'bytes' in capture ? analyzePngBytes(capture.bytes, capture.fileName, capture.overrides) : capture);
  return { ...fitBatch(extractions, options, overrides), elapsedMs: performance.now() - start };
}
