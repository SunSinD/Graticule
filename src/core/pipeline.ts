import { analyzeBodeBatch as fitBatch, frequenciesDiffer } from './bode.js';
import type { BodeOverrides } from './bode.js';
import { rectifyGrid } from './deskew.js';
import { extractTraces, makeTimebase } from './extract.js';
import { buildOverlayMask } from './mask.js';
import { compareScope, measureChannel, measurePhase, scopeFrequency } from './measurements.js';
import { readScopeMetadata } from './ocr.js';
import { decodePng } from './png.js';
import { detectProfile, getNativeProfile, invertTraceColors } from './profiles.js';
import type { BodeGateOptions, BodeRejectedCapture, BodeResult, ChannelId, ExtractionOverrides, ExtractionResult, RgbaImage } from './types.js';

export { recomputeBodeResult } from './bode.js';
export type { BodeOverrides } from './bode.js';
export { compareWithScopeCsv, parseScopeCsv } from './compare.js';
export type { ScopeComparisonMetrics, ScopeComparisonOptions, ScopeComparisonResult, ScopeCsvData } from './compare.js';
export { computeMathTrace } from './math.js';
export type { MathConfig, MathOp, MathTraceResult } from './types.js';
export { computeSpectrum, renderSpectrumCsv, renderSpectrumSvg, renderSpectrumTable } from './spectrum.js';
export type { SpectrumBin, SpectrumHarmonic, SpectrumOptions, SpectrumResult, SpectrumSvgOptions, SpectrumWindow, ThdReason } from './spectrum.js';
export { decodeUart } from './uart.js';
export type { UartDecodeResult, UartFrame, UartOptions } from './uart.js';
export { computeXyPlot, renderXyCsv, renderXySvg } from './xy.js';
export type { XyAxisId, XyPoint, XyResult, XySvgOptions, XyValidPoint } from './xy.js';

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
  const mask = buildOverlayMask(image, detection.grid, detection.profileId, metadata.digital);
  const sourceProfile = quad && detection.grid.inverted
    ? nativeGrid ? overrides.profileId : detectProfile(source).profileId : undefined;
  const inverted = sourceProfile === undefined ? undefined : invertTraceColors(source, sourceProfile, true);
  const { traces, warnings } = extractTraces(image, detection, metadata, mask, timebase, overrides, inverted);
  const measurements = traces.map(trace => measureChannel(trace, detection.grid.pxPerVDiv));
  const frequency = (channel: ChannelId) => timebase.source === 'default' ? null
    : scopeFrequency(scopeReadings, channel, topFrequencyHz, topFrequencyRaw)
      ?? measurements.find(measurement => measurement.channel === channel)?.frequencyHz ?? null;
  const phaseFor = (from: ChannelId, to: ChannelId) => {
    const fromFrequency = frequency(from), toFrequency = frequency(to);
    return frequenciesDiffer(fromFrequency, toFrequency) ? null : measurePhase(traces, fromFrequency ?? toFrequency, from, to);
  };
  const phaseC1ToC2 = phaseFor('C1', 'C2');
  const [first, second] = traces.filter(trace => trace.settings.enabled);
  const phase = first && second ? first.channel === 'C1' && second.channel === 'C2' ? phaseC1ToC2
    : phaseFor(first.channel, second.channel) : null;
  return {
    fileName, imageWidth: image.width, imageHeight: image.height,
    ...(quad && { sourceWidth: source.width, sourceHeight: source.height, sourceQuad: quad }),
    detection: warnings.length ? { ...detection, warnings: [...detection.warnings, ...warnings] } : detection,
    timebase, topFrequencyHz, topFrequencyRaw, traces,
    measurements, phaseC1ToC2, scopeReadings,
    ...(phase?.phaseDeg != null && { phasePair: { from: phase.refChannel, to: phase.targetChannel, phaseDeg: phase.phaseDeg } }),
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
  const extractions = captures.map(capture => {
    if (!('bytes' in capture)) return capture;
    try {
      return analyzePngBytes(capture.bytes, capture.fileName, capture.overrides);
    } catch {
      return { fileName: capture.fileName, rejectionReason: 'capture_unreadable' };
    }
  });
  return { ...fitBatch(extractions, options, overrides), elapsedMs: performance.now() - start };
}
