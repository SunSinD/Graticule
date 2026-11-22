import { CURSOR, OVERLAY } from './mask.js';
import type { OverlayMask } from './mask.js';
import type { ScopeMetadata } from './ocr.js';
import { at, CHANNELS, channelColor } from './pixels.js';
import type { ChannelColor } from './pixels.js';
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

function classifyPixel(r: number, g: number, b: number, colors: readonly ChannelColor[], inverted: boolean): number {
  return inverted ? channelColor(255 - r, 255 - g, 255 - b, colors) : channelColor(r, g, b, colors);
}

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

function markerYs(image: RgbaImage, detection: ProfileDetection, colors: readonly ChannelColor[]): (number | null)[] {
  const profile = getNativeProfile(detection.profileId);
  if (!profile) return [null, null, null, null];
  const { x, y, width, height } = profile.zeroMarkerStrip;
  const { bottom, centerY, inverted } = detection.grid;
  const lastRow = profile.raster ? Math.min(bottom, y + height - 1) : bottom;
  if (profile.id === 'keysight-dsox1000') {
    const arrows: (number | null)[] = CHANNELS.map(() => null);
    for (let row = Math.max(y, detection.grid.top + 2); row <= lastRow; row++) {
      const i = at(image, x + width - 1, row);
      const j = at(image, x + width - 9, row);
      const channel = classifyPixel(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, colors, false);
      if (channel >= 0 && channel === classifyPixel(image.data[j]!, image.data[j + 1]!, image.data[j + 2]!, colors, false)) {
        arrows[channel] = row;
      }
    }
    return arrows;
  }
  if (profile.id === 'rohde-schwarz-rtb2004') {
    const tips = CHANNELS.map((): number[] => []);
    for (let row = y; row <= lastRow; row++) {
      const i = at(image, x + width - 1, row);
      const channel = classifyPixel(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, colors, false);
      if (channel >= 0) tips[channel]!.push(row);
    }
    return tips.map(rows => {
      const ends = rows.slice(1).findIndex((row, index) => row - rows[index]! > 4);
      const last = rows.at(-1);
      if (last === undefined) return null;
      const center = (from: number, to: number) => (from + to) / 2;
      if (ends < 0) return center(rows[0]!, last);
      const firstBadge = center(rows[0]!, rows[ends]!);
      const lastBadge = center(rows[ends + 1]!, last);
      return Math.abs(firstBadge - centerY) > Math.abs(lastBadge - centerY) ? firstBadge : lastBadge;
    });
  }
  const counts = CHANNELS.map(() => new Uint16Array(Math.max(0, lastRow - y + 1)));
  for (let row = y; row <= lastRow; row++) {
    for (let col = x; col < x + width; col++) {
      const i = at(image, col, row);
      const channel = classifyPixel(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, colors, inverted);
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
  if (metadata.unsupportedChannels?.has(channel)) return null;
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

function plotAnnotations(image: RgbaImage, detection: ProfileDetection, markers: readonly (number | null)[]): Uint8Array | null {
  const { profileId, grid } = detection;
  const { left, right, top, bottom, hLines } = grid;
  if (profileId !== 'rigol-dho924' && profileId !== 'rohde-schwarz-rtb2004' && profileId !== 'siglent-sds800x-hd') return null;
  const pixels = new Uint8Array(image.width * image.height);
  const fill = (x1: number, y1: number, x2: number, y2: number) => {
    for (let y = Math.max(top, y1); y <= Math.min(bottom, y2); y++) {
      pixels.fill(OVERLAY, y * image.width + Math.max(left, x1), y * image.width + Math.min(right, x2) + 1);
    }
  };
  if (profileId === 'rigol-dho924') {
    for (const y of hLines.slice(1, -1)) fill(left + 8, Math.round(y) - 9, left + 36, Math.round(y) + 8);
    const zero = markers[0];
    if (zero != null) fill(left, Math.round(zero) - 13, left + 34, Math.round(zero) + 13);
    return pixels;
  }
  if (profileId === 'siglent-sds800x-hd') {
    for (const y of hLines.slice(1)) fill(left, Math.round(y) - 12, left + 65, Math.round(y) + 1);
    for (const x of grid.vLines.slice(1, -1)) fill(x - 32, bottom - 17, x + 32, bottom - 3);
    // A trigger level arrow can obscure samples along the last few columns.
    let first = -1;
    for (let y = top; y <= bottom + 1; y++) {
      const i = at(image, right - 1, Math.min(y, bottom));
      const c = image.data.subarray(i, i + 3);
      const pureInk = y <= bottom && Math.max(...c) === 255 && Math.min(...c) === 0;
      if (pureInk && first < 0) first = y;
      if (!pureInk && first >= 0) {
        if (y - first >= 7) fill(right - 9, first, right, y - 1);
        first = -1;
      }
    }
    return pixels;
  }
  for (const y of hLines.slice(1)) fill(left + 1, Math.round(y) - 18, left + 58, Math.round(y) - 4);
  fill(left + 1, bottom - 18, right - 1, bottom - 4);
  for (let x = left + 1; x < right; x++) {
    const i = at(image, x, top + 2);
    if (image.data[i] === 244 && image.data[i + 1] === 244 && image.data[i + 2] === 0) {
      fill(x - 4, top, x + 4, top + 30);
    }
  }
  for (let y = top; y < bottom; y++) {
    let badge = 0;
    for (let x = right - 40; x < right; x++) {
      const i = at(image, x, y);
      if (image.data[i] === 255 && image.data[i + 1] === 255 && image.data[i + 2] === 0) badge++;
    }
    if (badge >= 12) fill(right - 40, y - 3, right - 1, y + 3);
  }
  return pixels;
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
  const colors = metadata.colors ?? colorsFor(detection.profileId);
  const markers = markerYs(image, detection, colors);
  const annotations = plotAnnotations(image, detection, markers);
  const plotMask = annotations ? { ...mask, pixels: mask.pixels.map((bits, index) => bits | annotations[index]!) } : mask;
  const native = getNativeProfile(detection.profileId);
  const inverted = grid.inverted;
  const active = CHANNELS.map((channel, i) => !metadata.unsupportedChannels?.has(channel)
    && (overrides.channels?.[channel]?.enabled ?? (!native || metadata.cards.has(channel) || markers[i] !== null)));
  const columns = CHANNELS.map((): (Cluster | null)[] => []);

  for (let x = grid.left; x <= grid.right; x++) {
    const visible = CHANNELS.map(() => [] as { y: number; weight: number }[]);
    for (let y = grid.top; y <= grid.bottom; y++) {
      const pixel = y * image.width + x;
      const i = pixel * 4;
      if (plotMask.pixels[pixel] || image.data[i + 3]! < 128) continue;
      const r = image.data[i]!;
      const g = image.data[i + 1]!;
      const b = image.data[i + 2]!;
      const channel = classifyPixel(r, g, b, colors, inverted);
      if (channel < 0 || !active[channel]) continue;
      const peak = inverted ? 255 - Math.min(r, g, b) : Math.max(r, g, b);
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
    const markerInBounds = settings.zeroY >= grid.top + 8 && settings.zeroY <= grid.bottom - 8;
    return settings.zeroSource === 'card-offset' && markerInBounds && marker !== null && marker !== undefined && Math.abs(marker - settings.zeroY) > 4
      ? [`zero_marker_mismatch:${channel}`] : [];
  });
  for (const channel of metadata.unsupportedChannels ?? []) warnings.push(`unsupported_channel_unit:${channel}`);
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
        const maskBits = expected === null ? 0 : maskedAt(image, plotMask, grid, xPx, expected, tolerance + 1);
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
