import { CURSOR, OVERLAY } from './mask.js';
import type { OverlayMask } from './mask.js';
import type { ScopeMetadata } from './ocr.js';
import { at, CHANNELS, channelColor } from './pixels.js';
import { colorsFor, getNativeProfile } from './profiles.js';
import type { ChannelId, ChannelSettings, ChannelTrace, ExtractionOverrides, GapStatus, GridGeometry, ProfileDetection,
  RgbaImage, TimebaseSettings, TraceSample } from './types.js';

interface Cluster {
  readonly y: number;
  readonly low: number;
  readonly high: number;
  readonly score: number;
  readonly count: number;
}

const finite = (value: number | undefined | null): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: number | undefined | null): value is number => finite(value) && value > 0;

export function makeTimebase(metadata: ScopeMetadata, overrides: ExtractionOverrides): TimebaseSettings {
  const manualScale = positive(overrides.secPerDiv) ? overrides.secPerDiv : null;
  const manualOffset = finite(overrides.triggerOffsetSec) ? overrides.triggerOffsetSec : null;
  return {
    secPerDiv: manualScale ?? metadata.secPerDiv ?? 1e-3,
    triggerOffsetSec: manualOffset ?? metadata.triggerOffsetSec ?? 0,
    source: manualScale ? 'manual' : metadata.secPerDiv ? 'ocr' : 'default',
    rawText: metadata.rawTimebase,
  };
}

function markerYs(image: RgbaImage, detection: ProfileDetection): (number | null)[] {
  const profile = getNativeProfile(detection.profileId);
  if (!profile) return [null, null, null, null];
  const { x, y, width } = profile.zeroMarkerStrip;
  const { bottom } = detection.grid;
  const colors = colorsFor(profile.id);
  const counts = CHANNELS.map(() => new Uint8Array(bottom - y + 1));
  for (let row = y; row <= bottom; row++) {
    for (let col = x; col < x + width; col++) {
      const i = at(image, col, row);
      const channel = channelColor(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, colors);
      if (channel < 0) continue;
      const bins = counts[channel]!;
      bins[row - y] = bins[row - y]! + 1;
    }
  }
  return counts.map(bins => {
    let bestPixels = 6;
    let bestY: number | null = null;
    let row = 0;
    while (row < bins.length) {
      if (!bins[row]) {
        row++;
        continue;
      }
      const start = row;
      let sum = 0;
      let pixels = 0;
      while (row < bins.length && (bins[row] || bins[row + 1])) {
        sum += (y + row) * bins[row]!;
        pixels += bins[row]!;
        row++;
      }
      if (row - start <= 22 && pixels > bestPixels) {
        bestPixels = pixels;
        bestY = sum / pixels;
      }
    }
    return bestY;
  });
}

function pickSettings(channel: ChannelId, index: number, metadata: ScopeMetadata, overrides: ExtractionOverrides,
  detection: ProfileDetection, markers: (number | null)[], points: number): ChannelSettings | null {
  const manual = overrides.channels?.[channel];
  const card = metadata.cards.get(channel);
  const marker = markers[index] ?? null;
  const fallback = detection.profileId === 'universal-fallback';
  const enabled = manual?.enabled ?? (!detection.digitalOnly && (Boolean(card) || marker !== null || (fallback && points > 8)));
  if (!enabled) return null;

  const voltsPerDiv = positive(manual?.voltsPerDiv) ? manual.voltsPerDiv : card?.voltsPerDiv ?? 1;
  const scaleSource = positive(manual?.voltsPerDiv) ? 'manual' : card?.voltsPerDiv ? 'ocr' : 'default';
  const { centerY, pxPerVDiv } = detection.grid;
  const manualOffset = finite(manual?.offsetVolts) ? manual.offsetVolts : null;
  const cardOffset = card?.offsetVolts ?? null;
  const offset = manualOffset ?? cardOffset;
  const expectedZero = offset === null ? null : centerY - offset / voltsPerDiv * pxPerVDiv;
  const calibratedCard = cardOffset !== null && scaleSource !== 'default';
  const manualZero = finite(manual?.zeroY) ? manual.zeroY : null;
  const useCard = calibratedCard && expectedZero !== null;
  const zeroY = manualZero ?? (manualOffset !== null || useCard ? expectedZero : marker) ?? centerY;
  const zeroSource = manualZero !== null || manualOffset !== null ? 'manual'
    : useCard ? 'card-offset' : marker !== null ? 'marker' : 'default';

  return {
    channel, enabled, voltsPerDiv,
    offsetVolts: manualZero === null && (manualOffset !== null || useCard) ? offset! : (centerY - zeroY) / pxPerVDiv * voltsPerDiv,
    zeroY,
    probeAttenuation: card?.probeAttenuation ?? 1, coupling: card?.coupling ?? 'UNKNOWN', scaleSource, zeroSource,
    rawScaleText: card?.rawScaleText ?? null, rawOffsetText: card?.rawOffsetText ?? null,
  };
}

function strongestCluster(points: readonly { y: number; weight: number }[]): Cluster | null {
  let best: Cluster | null = null;
  let low = 0;
  let last = -Infinity;
  let count = 0;
  let score = 0;
  let weightedY = 0;
  const save = () => {
    if (!count) return;
    const rank = score / Math.sqrt(count);
    if (!best || rank > best.score) best = { y: weightedY / score, low, high: last, score: rank, count };
  };
  for (const { y, weight } of points) {
    if (y - last > 2) {
      save();
      low = y;
      count = 0;
      score = 0;
      weightedY = 0;
    }
    count++;
    last = y;
    score += weight;
    weightedY += y * weight;
  }
  save();
  return best;
}

function median(numbers: number[]): number {
  if (!numbers.length) return 0;
  const n = numbers.sort((a, b) => a - b);
  return (n[Math.floor(n.length / 2)]! + n[Math.floor((n.length - 1) / 2)]!) / 2;
}

interface TraceColumns {
  readonly channel: ChannelId;
  readonly settings: ChannelSettings;
  readonly clusters: readonly (Cluster | null)[];
  readonly thickness: number;
}

function nearbyObserved(clusters: TraceColumns['clusters'], x: number, limit: number): number | null {
  let before = x - 1;
  let after = x + 1;
  while (before >= Math.max(0, x - limit) && !clusters[before]) before--;
  while (after <= Math.min(clusters.length - 1, x + limit) && !clusters[after]) after++;
  const previous = x - before <= limit && before >= 0 ? clusters[before] : null;
  const next = after - x <= limit && after < clusters.length ? clusters[after] : null;
  if (previous && next) return previous.y + (next.y - previous.y) * (x - before) / (after - before);
  return previous?.y ?? next?.y ?? null;
}

function maskedAt(image: RgbaImage, mask: OverlayMask, grid: GridGeometry, x: number, y: number, tolerance: number): number {
  let hidden = 0;
  for (let row = Math.max(grid.top, Math.round(y) - tolerance); row <= Math.min(grid.bottom, Math.round(y) + tolerance); row++) {
    hidden |= mask.pixels[row * image.width + x]!;
  }
  return hidden;
}

export function extractTraces(image: RgbaImage, detection: ProfileDetection, metadata: ScopeMetadata, mask: OverlayMask,
  timebase: TimebaseSettings, overrides: ExtractionOverrides): { traces: ChannelTrace[]; warnings: string[] } {
  if (detection.digitalOnly) return { traces: [], warnings: [] };
  const grid = detection.grid;
  const colors = colorsFor(detection.profileId);
  const markers = markerYs(image, detection);
  const native = getNativeProfile(detection.profileId);
  const active = CHANNELS.map((channel, i) => overrides.channels?.[channel]?.enabled
    ?? (!native || metadata.cards.has(channel) || markers[i] !== null));
  const columns = CHANNELS.map((): (Cluster | null)[] => []);

  for (let x = grid.left; x <= grid.right; x++) {
    const visible = CHANNELS.map(() => [] as { y: number; weight: number }[]);
    for (let y = grid.top; y <= grid.bottom; y++) {
      const pixel = y * image.width + x;
      const i = pixel * 4;
      if (mask.pixels[pixel] || image.data[i + 3]! < 128) continue;
      const r = image.data[i]!;
      const g = image.data[i + 1]!;
      const b = image.data[i + 2]!;
      const channel = channelColor(r, g, b, colors);
      if (channel < 0 || !active[channel]) continue;
      const peak = Math.max(r, g, b);
      const weight = (peak / 255) ** 4;
      visible[channel]!.push({ y, weight });
    }
    for (const [index, column] of columns.entries()) {
      column.push(strongestCluster(visible[index]!));
    }
  }

  const traces = CHANNELS.flatMap((channel, index): TraceColumns[] => {
    const visible = columns[index]!;
    const settings = pickSettings(channel, index, metadata, overrides, detection, markers, visible.filter(Boolean).length);
    return settings ? [{ channel, settings, clusters: visible,
      thickness: median(visible.flatMap(cluster => cluster ? [cluster.count] : [])) }] : [];
  });

  const warnings = traces.flatMap(({ channel, settings }) => {
    const marker = markers[CHANNELS.indexOf(channel)];
    return settings.zeroSource === 'card-offset' && marker !== null && marker !== undefined && Math.abs(marker - settings.zeroY) > 4
      ? [`zero_marker_mismatch:${channel}`] : [];
  });
  const extracted = traces.map(trace => {
    const tolerance = Math.min(8, Math.max(2, Math.ceil(trace.thickness / 2)));
    const samples = trace.clusters.map((cluster, col): TraceSample => {
      const xPx = grid.left + col;
      const timeSec = (xPx - grid.centerX) / grid.pxPerHDiv * timebase.secPerDiv + timebase.triggerOffsetSec;
      let status: GapStatus = 'unresolved';
      if (cluster) {
        if (cluster.low <= grid.top + 1) status = 'clipped_high';
        else if (cluster.high >= grid.bottom - 1) status = 'clipped_low';
        else status = 'ok';
      } else {
        const expected = nearbyObserved(trace.clusters, col, 52);
        const maskBits = expected === null ? 0 : maskedAt(image, mask, grid, xPx, expected, tolerance + 1);
        if (maskBits & OVERLAY) status = 'masked_overlay';
        else if (maskBits & CURSOR) status = 'masked_cursor';
        else if (expected !== null && traces.some(other => {
          const candidate = other.clusters[col];
          return other.channel !== trace.channel && candidate && Math.abs(candidate.y - expected) <= tolerance + 1;
        })) status = 'overlap_ambiguous';
      }
      const yPx = status === 'ok' ? cluster!.y : null;
      return { col, xPx, yPx, timeSec, voltage: yPx === null ? null : (trace.settings.zeroY - yPx) * trace.settings.voltsPerDiv / grid.pxPerVDiv, status };
    });
    const count = (...statuses: GapStatus[]) => samples.reduce((n, sample) => n + Number(statuses.includes(sample.status)), 0);
    return {
      channel: trace.channel, settings: trace.settings, samples, validCount: count('ok'),
      clippedCount: count('clipped_high', 'clipped_low'), maskedCount: count('masked_cursor', 'masked_overlay'),
      overlapCount: count('overlap_ambiguous'), unresolvedCount: count('unresolved'), medianThicknessPx: trace.thickness,
    };
  });
  return { traces: extracted, warnings };
}
