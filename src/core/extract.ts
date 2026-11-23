import { scaleOffset } from './dsp.js';
import { CURSOR, OVERLAY } from './mask.js';
import type { OverlayMask } from './mask.js';
import type { ScopeMetadata } from './ocr.js';
import { at, CHANNELS, channelColor, MIN_VISIBLE_ALPHA, pixelMatches } from './pixels.js';
import type { ChannelColor } from './pixels.js';
import { colorsFor, getNativeProfile, invertTraceColors, makeGrid } from './profiles.js';
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

export function makeTimebase(metadata: ScopeMetadata, overrides: ExtractionOverrides, hDivs = 10): TimebaseSettings {
  const manualScale = positive(overrides.secPerDiv) ? overrides.secPerDiv : null;
  const manualOffset = finite(overrides.triggerOffsetSec) ? overrides.triggerOffsetSec : null;
  const secPerDiv = manualScale ?? metadata.secPerDiv ?? 1e-3;
  const triggerOffsetSec = manualOffset ?? metadata.triggerOffsetSec ?? 0;
  const span = secPerDiv * hDivs;
  if (!Number.isFinite(span) || !Number.isFinite(Math.abs(triggerOffsetSec) + span / 2)) {
    throw new Error(`Invalid time scale: ${secPerDiv} s/div over ${hDivs} divisions exceeds the numeric range`);
  }
  return {
    secPerDiv,
    triggerOffsetSec,
    source: manualScale ? 'manual' : metadata.secPerDiv ? 'ocr' : 'default',
    rawText: metadata.rawTimebase,
  };
}

function markerYs(image: RgbaImage, detection: ProfileDetection, colors: readonly ChannelColor[],
  inverted: boolean): (number | null)[] {
  const profile = getNativeProfile(detection.profileId);
  if (!profile) return [null, null, null, null];
  const { x, y, width, height } = profile.zeroMarkerStrip;
  const { bottom, centerY } = detection.grid;
  const lastRow = profile.raster ? Math.min(bottom, y + height - 1) : bottom;
  const colorAt = (col: number, row: number, invert: boolean) => {
    const i = at(image, col, row);
    const data = image.data;
    return data[i + 3]! >= MIN_VISIBLE_ALPHA ? classifyPixel(data[i]!, data[i + 1]!, data[i + 2]!, colors, invert) : -1;
  };
  if (profile.id === 'keysight-dsox1000') {
    const arrows: (number | null)[] = CHANNELS.map(() => null);
    for (let row = Math.max(y, detection.grid.top + 2); row <= lastRow; row++) {
      const channel = colorAt(x + width - 1, row, false);
      if (channel >= 0 && channel === colorAt(x + width - 9, row, false)) {
        arrows[channel] = row;
      }
    }
    return arrows;
  }
  if (profile.id === 'rohde-schwarz-rtb2004') {
    const tips = CHANNELS.map((): number[] => []);
    for (let row = y; row <= lastRow; row++) {
      const channel = colorAt(x + width - 1, row, false);
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
      const channel = colorAt(col, row, inverted);
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
  if (!Number.isFinite(voltsPerDiv * detection.grid.vDivs)) {
    throw new Error(`Invalid voltage scale for ${channel}: ${voltsPerDiv} V/div exceeds the numeric range across the grid`);
  }
  const scaleSource = positive(manual?.voltsPerDiv) ? 'manual' : card?.voltsPerDiv ? 'ocr' : 'default';
  const { centerY, pxPerVDiv } = detection.grid;
  const manualOffset = finite(manual?.offsetVolts) ? manual.offsetVolts : null;
  const cardOffset = card?.offsetVolts ?? null;
  const offset = manualOffset ?? cardOffset;
  const expectedZero = offset === null ? null : centerY - scaleOffset(offset, voltsPerDiv, pxPerVDiv);
  const calibratedCard = cardOffset !== null && scaleSource !== 'default';
  const manualZero = finite(manual?.zeroY) ? manual.zeroY : null;
  const useCard = calibratedCard && expectedZero !== null;
  const zeroY = manualZero ?? (manualOffset !== null || useCard ? expectedZero : marker) ?? centerY;
  const zeroSource = manualZero !== null || manualOffset !== null ? 'manual'
    : useCard ? 'card-offset' : marker !== null ? 'marker' : 'default';

  return {
    channel, enabled, voltsPerDiv,
    offsetVolts: manualZero === null && (manualOffset !== null || useCard) ? offset! : scaleOffset(centerY - zeroY, pxPerVDiv, voltsPerDiv),
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

function rtbBottomLabels(image: RgbaImage, grid: GridGeometry, fill: (x1: number, y1: number, x2: number, y2: number) => void): void {
  const left = grid.left + 1, top = grid.bottom - 20;
  const width = grid.width - 1, height = 19;
  const ink = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (pixelMatches(image, left + col, top + row, (r, g, b) => Math.max(r, g, b) >= 128)) ink[row * width + col] = 1;
    }
  }
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start]) continue;
    const queue = [start];
    ink[start] = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let i = 0; i < queue.length; i++) {
      const col = queue[i]! % width, row = Math.floor(queue[i]! / width);
      minX = Math.min(minX, col); maxX = Math.max(maxX, col);
      minY = Math.min(minY, row); maxY = Math.max(maxY, row);
      for (let y = Math.max(0, row - 1); y <= Math.min(height - 1, row + 1); y++) {
        for (let x = Math.max(0, col - 1); x <= Math.min(width - 1, col + 1); x++) {
          const next = y * width + x;
          if (!ink[next]) continue;
          ink[next] = 0;
          queue.push(next);
        }
      }
    }
    // The labels are made of small glyphs. Waveforms can run across the band or cross its edges.
    if (maxX - minX < 20 && maxY - minY >= 4 && maxY - minY < 15 && minY > 0 && maxY < height - 1) {
      fill(left + minX, top + minY, left + maxX, top + maxY);
    }
  }
}

function plotAnnotations(image: RgbaImage, detection: ProfileDetection, markers: readonly (number | null)[]): Uint8Array | null {
  const { profileId, grid } = detection;
  const { left, right, top, bottom } = grid;
  if (profileId !== 'rigol-dho924' && profileId !== 'rohde-schwarz-rtb2004' && profileId !== 'siglent-sds800x-hd') return null;
  const native = getNativeProfile(profileId)!.graticule;
  const { hLines, vLines } = grid.hDivs === native.hDivs && grid.vDivs === native.vDivs ? grid
    : makeGrid(left, top, right, bottom, native.hDivs, native.vDivs, grid.layoutVariant, grid.inverted);
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
    for (const x of vLines.slice(1, -1)) fill(Math.round(x) - 32, bottom - 17, Math.round(x) + 32, bottom - 3);
    // A trigger level arrow can obscure samples along the last few columns.
    const base = right - 1;
    const packed = (x: number, y: number) => {
      const i = at(image, x, y);
      if (image.data[i + 3]! < MIN_VISIBLE_ALPHA) return -1;
      return (image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!;
    };
    for (let y = top + 3; y <= bottom - 3; y++) {
      const color = packed(base, y);
      const rgb = [color >> 16, (color >> 8) & 255, color & 255];
      if (Math.max(...rgb) !== 255 || Math.min(...rgb) !== 0
          || packed(base, y - 3) !== color || packed(base, y + 3) !== color) continue;
      let tip = base;
      while (tip > Math.max(left, right - 12) && packed(tip - 1, y) === color) tip--;
      if (base - tip < 3 || packed(tip, y - 2) === color || packed(tip, y + 2) === color) continue;
      let shapeTop = y;
      let shapeBottom = y;
      while (shapeTop > top && y - shapeTop < 12 && packed(base, shapeTop - 1) === color) shapeTop--;
      while (shapeBottom < bottom && shapeBottom - y < 12 && packed(base, shapeBottom + 1) === color) shapeBottom++;
      if (Math.abs(shapeTop + shapeBottom - 2 * y) > 2 || shapeBottom - shapeTop >= 18) continue;
      for (let row = shapeTop; row <= shapeBottom; row++) {
        for (let x = base; x >= tip && packed(x, row) === color; x--) fill(x, row, x, row);
      }
    }
    return pixels;
  }
  for (const y of hLines.slice(1, -1)) fill(left + 1, Math.round(y) - 18, left + 58, Math.round(y) - 4);
  rtbBottomLabels(image, grid, fill);
  for (let x = left + 1; x < right; x++) {
    if (pixelMatches(image, x, top + 2, (r, g, b) => r === 244 && g === 244 && b === 0)) {
      fill(x - 4, top, x + 4, top + 30);
    }
  }
  const badgeInk = (r: number, g: number, b: number) => r === 255 && g === 255 && b === 0;
  let badgeRows = 0;
  for (let y = top; y < bottom; y++) {
    let badge = 0;
    for (let x = right - 40; x < right; x++) {
      if (pixelMatches(image, x, y, badgeInk)) badge++;
    }
    badgeRows = badge >= 12 && !pixelMatches(image, right - 41, y, badgeInk) ? badgeRows + 1 : 0;
    if (badgeRows >= 3) fill(right - 40, y - 5, right - 1, y + 3);
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
  timebase: TimebaseSettings, overrides: ExtractionOverrides,
  inverted = invertTraceColors(image, overrides.profileId ?? detection.profileId, detection.grid.inverted, detection.grid)): { traces: ChannelTrace[]; warnings: string[] } {
  const grid = detection.grid;
  const times = Array.from({ length: grid.width + 1 }, (_, col) =>
    (grid.left + col - grid.centerX) / grid.pxPerHDiv * timebase.secPerDiv + timebase.triggerOffsetSec);
  if (times.some((time, col) => !Number.isFinite(time) || (col > 0 && time <= times[col - 1]!))) {
    throw new Error('Invalid trigger offset or time scale: adjacent columns need distinct timestamps.');
  }
  if (detection.digitalOnly) return { traces: [], warnings: [] };
  const colors = metadata.colors ?? colorsFor(overrides.profileId ?? detection.profileId);
  const markers = markerYs(image, detection, colors, inverted);
  const annotations = plotAnnotations(image, detection, markers);
  const plotMask = annotations ? { ...mask, pixels: mask.pixels.map((bits, index) => bits | annotations[index]!) } : mask;
  const native = getNativeProfile(detection.profileId);
  const active = CHANNELS.map((channel, i) => !metadata.unsupportedChannels?.has(channel)
    && (overrides.channels?.[channel]?.enabled ?? (!native || metadata.cards.has(channel) || markers[i] !== null)));
  const columns = CHANNELS.map((): (Cluster | null)[] => []);

  for (let x = grid.left; x <= grid.right; x++) {
    const visible = CHANNELS.map(() => [] as { y: number; weight: number }[]);
    for (let y = grid.top; y <= grid.bottom; y++) {
      const pixel = y * image.width + x;
      const i = pixel * 4;
      if (plotMask.pixels[pixel] || image.data[i + 3]! < MIN_VISIBLE_ALPHA) continue;
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
      const timeSec = times[col]!;
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
      const voltage = yPx === null ? null : scaleOffset(trace.settings.zeroY - yPx, grid.pxPerVDiv, trace.settings.voltsPerDiv);
      if (voltage !== null && !Number.isFinite(voltage)) {
        return { col, xPx, yPx: null, timeSec, voltage: null, status: 'unresolved' };
      }
      return { col, xPx, yPx, timeSec, voltage, status };
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
