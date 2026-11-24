import data from './profiles.json' with { type: 'json' };
import { cropFollowsGridAxis } from './deskew.js';
import { matchBitmap, readBitmap } from './font/matcher.js';
import { compactBadgeGlyphs, logo as siglentLogo } from './font/siglentFont.js';
import { logo as rigolLogo } from './font/rigolFont.js';
import { rasterFonts } from './font/rasterFonts.js';
import { at, CHANNELS, channelColor, hueDegrees, MIN_VISIBLE_ALPHA, pixelMatches } from './pixels.js';
import type { ChannelColor, PixelPredicate } from './pixels.js';
import type { ChannelId, ExtractionOverrides, GridGeometry, LayoutVariant, ProfileDetection, ProfileId, Rect, RgbaImage } from './types.js';

interface NativeVariant {
  readonly id: Exclude<LayoutVariant, 'manual'>;
  readonly top?: number;
  readonly right?: number;
  readonly bottom: number;
  readonly pxPerVDiv: number;
  readonly measureBar: (Rect & { readonly rows: number }) | null;
}

type Rgb = readonly [number, number, number];

interface RasterAnchors {
  readonly logoInk: Rgb;
  readonly headerInk: Rgb;
  readonly footerInk: Rgb;
  readonly topEdgeInk: Rgb;
  readonly bottomEdgeInk: Rgb;
  readonly sideEdgeInk: Rgb;
  readonly lineInk: readonly Rgb[];
  readonly lineFill: number;
}

interface NativeProfile {
  readonly id: Exclude<ProfileId, 'universal-fallback'>;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly supportsInverted: boolean;
  readonly anchors: { readonly logoRoi: Rect; readonly topBarRoi: Rect; readonly bottomBarRoi: Rect };
  readonly graticule: {
    readonly left: number; readonly right: number; readonly top: number;
    readonly hDivs: number; readonly vDivs: number; readonly pxPerHDiv: number;
    readonly variants: readonly NativeVariant[];
  };
  readonly zeroMarkerStrip: Rect;
  readonly topFrequencyRoi: Rect | null;
  readonly timebaseCard: { readonly box: Rect; readonly scaleRoi: Rect; readonly delayRoi: Rect };
  readonly channelCardSlots: readonly (Rect & { readonly slot: number })[];
  readonly channels: Readonly<Partial<Record<ChannelId, ChannelColor>>>;
  readonly raster?: RasterAnchors;
}

const profileVariants = {
  'siglent-sds2000x-plus': ['no-measure', 'measure-1row', 'measure-2row'],
  'rigol-ds1054z': ['standard', 'measure-1row', 'fft'],
  'siglent-sds1000x-e': ['standard'],
  'rigol-dho924': ['fft'],
  'rohde-schwarz-rtb2004': ['standard', 'measure-1row'],
  'tektronix-dpo7104c': ['standard'],
  'siglent-sds800x-hd': ['measure-stats'],
  'keysight-dsox1000': ['standard', 'decode-table'],
} satisfies Record<NativeProfile['id'], readonly NativeVariant['id'][]>;

type RasterProfileId = keyof typeof rasterFonts;

export function isRasterProfile(id: ProfileId): id is RasterProfileId {
  return Object.hasOwn(rasterFonts, id);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown): v is number => finite(v) && Number.isInteger(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const isRgb = (v: unknown): v is Rgb => Array.isArray(v) && v.length === 3 && v.every(level => int(level) && level >= 0 && level <= 255);
const isNativeId = (id: unknown): id is NativeProfile['id'] => typeof id === 'string' && Object.hasOwn(profileVariants, id);

export function validateProfiles(value: unknown): readonly NativeProfile[] {
  function validProfile(p: unknown): p is NativeProfile {
    if (!isRecord(p) || !isNativeId(p.id)
        || typeof p.name !== 'string' || !p.name.trim() || !int(p.width) || p.width < 1
        || !int(p.height) || p.height < 1 || typeof p.supportsInverted !== 'boolean') return false;
    const { width, height, raster } = p;
    const measuredRaster = isRasterProfile(p.id);
    if (measuredRaster) {
      if (!isRecord(raster) || !isRgb(raster.logoInk) || !isRgb(raster.headerInk) || !isRgb(raster.footerInk)
          || !isRgb(raster.topEdgeInk) || !isRgb(raster.bottomEdgeInk) || !isRgb(raster.sideEdgeInk)
          || !Array.isArray(raster.lineInk) || !raster.lineInk.length || !raster.lineInk.every(isRgb)
          || !positive(raster.lineFill) || raster.lineFill > 1 || p.supportsInverted) return false;
    } else if (raster !== undefined) return false;
    function rect(r: unknown): r is Rect {
      return isRecord(r) && int(r.x) && int(r.y) && int(r.width) && int(r.height)
        && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
        && r.x + r.width <= width && r.y + r.height <= height;
    }
    const { anchors, graticule: g, timebaseCard: t, channels } = p;
    if (!isRecord(anchors) || !rect(anchors.logoRoi) || !rect(anchors.topBarRoi) || !rect(anchors.bottomBarRoi)
        || !rect(p.zeroMarkerStrip) || (p.topFrequencyRoi !== null && !rect(p.topFrequencyRoi))
        || !isRecord(t) || !rect(t.box) || !rect(t.scaleRoi) || !rect(t.delayRoi)
        || !isRecord(channels) || !Array.isArray(p.channelCardSlots)
        || (!measuredRaster && p.channelCardSlots.length !== 4)
        || !p.channelCardSlots.every((s: unknown, i) => isRecord(s) && int(s.slot) && s.slot >= 0 && s.slot < CHANNELS.length
          && (measuredRaster || s.slot === i) && rect(s))
        || new Set(p.channelCardSlots.map(s => s.slot)).size !== p.channelCardSlots.length) return false;
    if (isRasterProfile(p.id)) {
      const { logo } = rasterFonts[p.id];
      const { width: logoWidth, height: logoHeight } = anchors.logoRoi;
      if (logo.length !== logoHeight || logo.some(row => row.length !== logoWidth)) return false;
    }
    if (!isRecord(g) || !int(g.left) || !int(g.right) || !int(g.top) || g.left < 0 || g.right <= g.left
        || g.right >= width || g.top < 0 || g.top >= height || !int(g.hDivs) || g.hDivs < 1
        || !int(g.vDivs) || g.vDivs < 1 || !positive(g.pxPerHDiv)
        || g.pxPerHDiv * g.hDivs !== g.right - g.left || !Array.isArray(g.variants)) return false;
    const variants = profileVariants[p.id];
    const { top, vDivs } = g;
    if (g.variants.length !== variants.length || !g.variants.every((v: unknown, i) =>
      isRecord(v) && v.id === variants[i] && int(v.bottom) && v.bottom > top && v.bottom < height
      && (v.top === undefined || (measuredRaster && int(v.top) && v.top >= top && v.top < v.bottom))
      && positive(v.pxPerVDiv) && v.pxPerVDiv * vDivs === v.bottom - (int(v.top) ? v.top : top)
      && (v.right === undefined || (measuredRaster && int(v.right) && int(g.left) && int(g.right) && v.right > g.left && v.right < g.right))
      && (v.id === 'no-measure' || v.id === 'fft' || v.id === 'measure-stats'
        || (measuredRaster && (v.id === 'standard' || v.id === 'decode-table')) ? v.measureBar === null
        : isRecord(v.measureBar) && v.measureBar.rows === (v.id === 'measure-2row' ? 2 : 1) && rect(v.measureBar)))) return false;
    const coveredSlots = new Set(p.channelCardSlots.map(slot => slot.slot));
    return CHANNELS.every((id, index) => {
      const c = channels[id];
      if (measuredRaster && !coveredSlots.has(index)) return c === undefined;
      return isRecord(c) && isRgb(c.rgb)
        && finite(c.hueMin) && finite(c.hueMax) && c.hueMin >= 0 && c.hueMax <= 360 && c.hueMin <= c.hueMax
        && positive(c.satMin) && c.satMin <= 1 && positive(c.valMin) && c.valMin <= 1;
    });
  }
  const count = Object.keys(profileVariants).length;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length !== count
      || !value.profiles.every(validProfile) || new Set(value.profiles.map(p => p.id)).size !== count) {
    throw new Error('Invalid oscilloscope profile configuration');
  }
  return value.profiles;
}

const profiles = validateProfiles(data);
export const getNativeProfile = (id: ProfileId) => profiles.find(p => p.id === id);
const unmeasuredColor: ChannelColor = { rgb: [0, 0, 0], hueMin: 0, hueMax: 360, satMin: 1, valMin: 2 };
export function colorsFor(id: ProfileId): ChannelColor[] {
  const { channels } = getNativeProfile(id) ?? profiles[0]!;
  return CHANNELS.map(channel => channels[channel] ?? unmeasuredColor);
}

function rgbNear([r, g, b]: Rgb, tolerance = 6): PixelPredicate {
  return (red, green, blue) => Math.abs(red - r) <= tolerance && Math.abs(green - g) <= tolerance && Math.abs(blue - b) <= tolerance;
}

export function makeGrid(left: number, top: number, right: number, bottom: number, hDivs: number, vDivs: number,
  layoutVariant: LayoutVariant, inverted: boolean, fitErrorPx = 0): GridGeometry {
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  return {
    left, top, right, bottom, width, height, hDivs, vDivs, centerX: (left + right) / 2, centerY: (top + bottom) / 2,
    pxPerHDiv: width / hDivs, pxPerVDiv: height / vDivs,
    vLines: Array.from({ length: hDivs + 1 }, (_, i) => left + width * i / hDivs),
    hLines: Array.from({ length: vDivs + 1 }, (_, i) => top + height * i / vDivs),
    layoutVariant, inverted, fitErrorPx,
  };
}

const grayscale = (r: number, g: number, b: number, min: number, max: number) =>
  r >= min && r <= max && Math.max(r, g, b) - Math.min(r, g, b) <= 12;
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function proportion(image: RgbaImage, roi: Rect, predicate: PixelPredicate, step = 1): number {
  let matches = 0;
  let total = 0;
  for (let y = roi.y; y < roi.y + roi.height; y += step) {
    for (let x = roi.x; x < roi.x + roi.width; x += step) {
      if (pixelMatches(image, x, y, predicate)) matches++;
      total++;
    }
  }
  return matches / total;
}

function logoOverlap(image: RgbaImage, roi: Rect, stencil: readonly string[], predicate: PixelPredicate): number {
  const { x, y, width, height } = roi;
  let intersection = 0;
  let union = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const expected = stencil[row]?.[col] === '1';
      const actual = pixelMatches(image, x + col, y + row, predicate);
      if (expected || actual) union++;
      if (expected && actual) intersection++;
    }
  }
  return union > 0 ? intersection / union : 0;
}

const siglentLogoInk = (inverted: boolean): PixelPredicate =>
  (r, g, b) => inverted ? Math.max(r, g, b) < 155 : Math.min(r, g, b) > 100;

export function hasCompactSiglentHeader(image: RgbaImage, inverted: boolean): boolean {
  return logoOverlap(image, { x: 736, y: 3, width: 74, height: 14 }, siglentLogo, siglentLogoInk(inverted)) >= 0.78;
}

function logoMatch(image: RgbaImage, p: NativeProfile, inverted: boolean): boolean {
  const roi = p.anchors.logoRoi;
  if (p.raster && isRasterProfile(p.id)) return logoOverlap(image, roi, rasterFonts[p.id].logo, rgbNear(p.raster.logoInk, 36)) >= 0.82;
  if (p.id === 'siglent-sds2000x-plus') return logoOverlap(image, roi, siglentLogo, siglentLogoInk(inverted)) >= 0.78;
  return logoOverlap(image, roi, rigolLogo, (r, g, b) => Math.min(r, g) - b >= 52) >= 0.78
    || logoOverlap(image, { ...roi, x: roi.x - 1, y: roi.y + 1 }, rigolLogo,
      (r, g, b) => b - Math.max(r, g) >= 65) >= 0.65;
}

function findRasterPlot(image: RgbaImage, profile: NativeProfile, raster: RasterAnchors): GridGeometry | null {
  const { left, right, hDivs, vDivs, variants } = profile.graticule;
  const keysight = profile.id === 'keysight-dsox1000';
  const sds800 = profile.id === 'siglent-sds800x-hd';
  const topEdge = rgbNear(raster.topEdgeInk);
  const bottomEdge = rgbNear(raster.bottomEdgeInk);
  const sideEdge = rgbNear(raster.sideEdgeInk);
  const lineColors = raster.lineInk.map(ink => rgbNear(ink, 2));
  const lineInk: PixelPredicate = (r, g, b) => lineColors.some(ink => ink(r, g, b));
  for (const variant of variants) {
    const visibleRight = variant.right ?? right;
    const { bottom, top = profile.graticule.top } = variant;
    const plan = makeGrid(left, top, right, bottom, hDivs, vDivs, variant.id, false);
    const span = (y: number, ink: PixelPredicate) => proportion(image, { x: left + 4, y, width: visibleRight - left - 7, height: 1 }, ink);
    const column = (x: number, ink: PixelPredicate) => proportion(image, { x, y: top + 4, width: 1, height: bottom - top - 7 }, ink);
    const decodeTop = keysight && variant.id === 'decode-table';
    const upper = decodeTop ? rgbNear([86, 90, 92]) : topEdge;
    if (span(keysight && !decodeTop ? top + 1 : top, upper) < 0.70
        || span(sds800 ? bottom - 1 : bottom, bottomEdge) < 0.70
        || column(keysight || sds800 ? left - 1 : left, sideEdge) < 0.62 || column(visibleRight, sideEdge) < 0.62) continue;

    const rows = plan.hLines.slice(1, -1);
    const cols = plan.vLines.slice(1, -1).filter(x => x < visibleRight);
    const fit = (lines: readonly number[], hasInk: (line: number) => number) => lines.flatMap(line => {
      const nominal = Math.round(line);
      const found = [nominal, nominal - 1, nominal + 1].find(candidate => hasInk(candidate) >= raster.lineFill);
      return found === undefined ? [] : [Math.abs(found - line)];
    });
    const errors = fit(rows, y => span(y, lineInk));
    if (errors.length < rows.length - 2 || fit(cols, x => column(x, lineInk)).length < cols.length - 2) continue;

    return { ...plan, right: visibleRight, width: visibleRight - left,
      vLines: plan.vLines.filter(x => x <= visibleRight), fitErrorPx: errors.reduce((sum, error) => sum + error, 0) / errors.length };
  }
  return null;
}

function findPlot(image: RgbaImage, p: NativeProfile, inverted: boolean, compact: boolean): GridGeometry | null {
  const g = p.graticule;
  const siglent = p.id === 'siglent-sds2000x-plus';
  const border: PixelPredicate = (r, gr, b) => inverted ? grayscale(r, gr, b, 220, 232)
    : grayscale(r, gr, b, siglent ? 28 : 44, siglent ? 34 : 53);
  const gridInk: PixelPredicate = (r, gr, b) => inverted ? grayscale(r, gr, b, 162, compact ? 206 : 188)
    : grayscale(r, gr, b, compact ? 49 : siglent ? 74 : 43, siglent ? 87 : 53);
  const { left, top, hDivs, vDivs } = g;

  const standard = g.variants.map(variant => ({ id: variant.id, bottom: variant.bottom, right: g.right }));
  const variants = compact ? [
    ...standard,
    { id: 'measure-3row', bottom: 459, right: g.right },
    { id: 'decode-table', bottom: 380, right: 872 },
  ] as const : siglent ? standard : standard.reverse();
  for (const variant of variants) {
    const { bottom, right } = variant;
    const span = (y: number, ink: PixelPredicate) => proportion(image, { x: left + 5, y, width: right - left - 10, height: 1 }, ink);
    if (span(top, border) < 0.78) continue;
    const bottomEdge = siglent ? span(bottom + 1, border) >= 0.58
      : span(bottom - 1, border) >= 0.78
        || span(bottom, (r, gr, b) => grayscale(r, gr, b, 88, 108)) >= 0.58;
    if (!bottomEdge) continue;
    const grid = makeGrid(left, top, right, bottom, hDivs, vDivs, variant.id, inverted);
    if (variant.id === 'fft') {
      if (span(bottom + 20, border) >= 0.78) return grid;
      continue;
    }
    const horizontalOffsets: number[] = [];
    let vertical = 0;
    for (const y of grid.hLines.slice(1, -1)) {
      const nominal = Math.round(y);
      const rows = [nominal, nominal - 1, nominal + 1];
      const row = rows.find(candidate => span(candidate, gridInk) >= 0.16);
      if (row !== undefined) horizontalOffsets.push(Math.abs(row - y));
    }
    for (const x of grid.vLines.slice(1, -1)) {
      if ([Math.round(x), Math.round(x) - 1, Math.round(x) + 1].some(col => proportion(image,
        { x: col, y: top + 8, width: 1, height: bottom - top - 16 }, gridInk) > 0.14)) vertical++;
    }
    if (horizontalOffsets.length >= vDivs - 4 && vertical >= hDivs - 4) {
      return { ...grid, fitErrorPx: horizontalOffsets.reduce((sum, error) => sum + error, 0) / horizontalOffsets.length };
    }
  }
  return null;
}

export interface NativeCards {
  readonly digital: boolean;
  readonly analog: ReadonlyMap<ChannelId, Rect>;
  readonly colors?: readonly ChannelColor[];
}

function negativeTraceColors(image: RgbaImage, plot: Rect): boolean {
  const colors = colorsFor('universal-fallback');
  let normal = 0;
  let negated = 0;
  const x0 = Math.max(0, Math.floor(plot.x)), y0 = Math.max(0, Math.floor(plot.y));
  const x1 = Math.min(image.width - 1, Math.ceil(plot.x + plot.width)), y1 = Math.min(image.height - 1, Math.ceil(plot.y + plot.height));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = at(image, x, y);
      if (image.data[i + 3]! < MIN_VISIBLE_ALPHA) continue;
      const r = image.data[i]!, g = image.data[i + 1]!, b = image.data[i + 2]!;
      normal += Number(channelColor(r, g, b, colors) >= 0);
      negated += Number(channelColor(255 - r, 255 - g, 255 - b, colors) >= 0);
    }
  }
  // Complementary hues can match in both orientations. Switch to normal colors only
  // when their pixel count exceeds the inverted count by more than 20%.
  return normal <= negated * 1.2;
}

export function invertTraceColors(image: RgbaImage, profileId: ProfileId, inverted: boolean,
  plot?: Pick<GridGeometry, 'left' | 'top' | 'width' | 'height'>): boolean {
  if (!inverted) return false;
  // A bright fallback capture can be a full RGB negative or a white-background export
  // that keeps normal trace colors.
  if (profileId === 'universal-fallback') {
    return plot ? negativeTraceColors(image, { x: plot.left, y: plot.top, width: plot.width, height: plot.height }) : true;
  }
  if (profileId !== 'siglent-sds2000x-plus') return true;
  // The scope darkens its color badges in print mode. A full RGB negative instead
  // complements them, which can happen when a capture was inverted after saving.
  for (const x of [36, 163, 290, 417, 544, 140, 244, 348, 452]) {
    const i = at(image, x, 550);
    if (image.data[i + 3]! < MIN_VISIBLE_ALPHA) continue;
    const r = image.data[i]!, g = image.data[i + 1]!, b = image.data[i + 2]!;
    const high = Math.max(r, g, b);
    if (high >= 175 && high <= 182 && Math.min(r, g, b) <= 4) return false;
  }
  return true;
}

function findCompactSiglentCards(image: RgbaImage, invertColors: boolean, inverted: boolean): NativeCards {
  const analog = new Map<ChannelId, Rect>();
  const colors = colorsFor('siglent-sds2000x-plus').map(color => ({ ...color, valMin: 2 }));
  let digital = false;
  for (let x = 4; x <= 420; x += 104) {
    const index = at(image, x + 32, 550);
    if (image.data[index + 3]! < MIN_VISIBLE_ALPHA) continue;
    const rgb = Array.from(image.data.subarray(index, index + 3), value => invertColors ? 255 - value : value);
    const high = Math.max(...rgb);
    const spread = high - Math.min(...rgb);
    if (high < 140 || spread < 90) continue;
    const component = rgb.indexOf(high);
    const label = matchBitmap(readBitmap(image, { x: x + 3, y: 544, width: 31, height: 12 },
      (...levels) => invertColors ? 255 - levels[component]! < high * 0.7
        : inverted ? levels[component]! > high + 20 : levels[component]! < high * 0.7), compactBadgeGlyphs);
    if (label === 'D') {
      digital = true;
      continue;
    }
    const channel = CHANNELS.find(id => id === label);
    if (!channel) continue;
    analog.set(channel, { x, y: 540, width: 100, height: 56 });
    const hue = hueDegrees(rgb[0]!, rgb[1]!, rgb[2]!, high, spread);
    colors[CHANNELS.indexOf(channel)] = {
      rgb, hueMin: (hue + 345) % 360, hueMax: (hue + 15) % 360, satMin: 0.4, valMin: 0.32,
    };
  }
  return { analog, digital, colors };
}

export function rigolScaleRoi(slot: Rect): Rect {
  return { x: slot.x + 46, y: 461, width: 54, height: 12 };
}

export function rigolCardInk(color: ChannelColor): PixelPredicate {
  const [red, green, blue] = color.rgb;
  return (r, g, b) => Math.abs(r - red!) < 12 && Math.abs(g - green!) < 12 && Math.abs(b - blue!) < 12;
}

export function findNativeCards(image: RgbaImage, profile: NativeProfile, inverted: boolean, compact = false): NativeCards {
  const invertColors = invertTraceColors(image, profile.id, inverted);
  if (compact) return findCompactSiglentCards(image, invertColors, inverted);
  const analog = new Map<ChannelId, Rect>();
  let digital = false;
  const colors = colorsFor(profile.id);
  if (profile.raster) {
    for (const slot of profile.channelCardSlots) {
      if (profile.id === 'siglent-sds800x-hd') {
        const badge = { x: slot.x + 5, y: slot.y + 3, width: 30, height: 16 };
        for (const [i, channel] of CHANNELS.entries()) {
          const label = matchBitmap(readBitmap(image, badge, (r, g, b) => channelColor(r, g, b, colors) === i),
            rasterFonts['siglent-sds800x-hd'].glyphs);
          if (label === channel) analog.set(channel, slot);
        }
        continue;
      }
      if (profile.id === 'keysight-dsox1000') {
        const scale = { x: slot.x + 21, y: slot.y, width: 51, height: slot.height };
        if (proportion(image, scale, (r, g, b) => Math.min(r, g, b) > 170) >= 0.025) {
          analog.set(CHANNELS[slot.slot]!, slot);
        }
        continue;
      }
      const active = proportion(image, slot, (r, g, b) => channelColor(r, g, b, colors) === slot.slot);
      if (active > 0.12) analog.set(CHANNELS[slot.slot]!, slot);
    }
    return { analog, digital };
  }
  for (const [i, slot] of profile.channelCardSlots.entries()) {
    if (profile.id === 'rigol-ds1054z') {
      const color = colors[i]!;
      const active = proportion(image, rigolScaleRoi(slot), rigolCardInk(color));
      if (active > 0.035) analog.set(CHANNELS[i]!, slot);
      continue;
    }
    const badge = { x: slot.x + 1, y: slot.y + 2, width: 42, height: 12 };
    const blue: PixelPredicate = (r, g, b) => (b > (inverted ? 147 : 193) && g > 39 && g < 94 && r < 45)
      || (inverted && r > 210 && g > 159 && g < 220 && b > 17 && b < 62);
    if (proportion(image, badge, blue) > 0.65) {
      digital = true;
      continue;
    }
    for (const [index, id] of CHANNELS.entries()) {
      if (proportion(image, badge, (r, g, b) => (invertColors
        ? channelColor(255 - r, 255 - g, 255 - b, colors) : channelColor(r, g, b, colors)) === index) > 0.65) {
        analog.set(id, slot);
        break;
      }
    }
  }
  return { analog, digital };
}

const divisions = (n: number | undefined, fallback: number) => int(n) && n >= 1 && n <= 100 ? n : fallback;

function hantekGrid(image: RgbaImage): GridGeometry | null {
  if (image.width !== 800 || image.height !== 480) return null;
  const left = 15, right = 784, top = 31, bottom = 430;
  const centerX = 399, centerY = 230, pitch = 50;
  const ink: PixelPredicate = (r, g, b) => grayscale(r, g, b, 140, 185);
  if (![top, bottom].every(y =>
    proportion(image, { x: left, y, width: right - left + 1, height: 1 }, ink, 5) > 0.9)
    || ![left, right].every(x =>
      proportion(image, { x, y: top, width: 1, height: bottom - top + 1 }, ink, 5) > 0.9)) return null;
  const colors = colorsFor('universal-fallback');
  const axis: PixelPredicate = (r, g, b) => ink(r, g, b) || channelColor(r, g, b, colors) >= 0;
  if (proportion(image, { x: left, y: centerY, width: right - left + 1, height: 1 }, axis, 5) <= 0.9
      || proportion(image, { x: centerX, y: top, width: 1, height: bottom - top + 1 }, axis, 5) <= 0.9
      || proportion(image, { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
        (r, g, b) => luminance(r, g, b) < 38, 7) <= 0.65) return null;

  const vLines = Array.from({ length: 15 }, (_, i) => centerX + (i - 7) * pitch);
  const hLines = Array.from({ length: 9 }, (_, i) => centerY + (i - 4) * pitch);
  // The vertical grid lines are dotted at 10 px intervals. Probe away from the horizontal lines.
  const dots = vLines.filter(x => x !== centerX)
    .flatMap(x => [50, 100, 150, 200, 250, 300, 350, 400].map(y => pixelMatches(image, x, y, ink)));
  if (dots.filter(Boolean).length < dots.length * 0.85) return null;
  // The outer border cuts through the last division on both sides.
  return {
    ...makeGrid(left, top, right, bottom, vLines.length - 1, hLines.length - 1, 'standard', false),
    centerX, centerY, vLines, hLines, pxPerHDiv: pitch, pxPerVDiv: pitch,
  };
}

function fallbackGrid(image: RgbaImage, overrides: ExtractionOverrides, detected: GridGeometry | null): GridGeometry {
  const bound = (value: number, max: number) => Math.min(Math.max(0, max), Math.max(0, Math.round(value)));
  const { width, height } = image;
  const crop = overrides.manualCrop;
  const invert = (l: number, t: number, r: number, b: number) => proportion(image,
    { x: l, y: t, width: Math.max(1, r - l), height: Math.max(1, b - t) }, (r, g, b) => luminance(r, g, b) > 210, 5) > 0.6;

  const build = (left: number, top: number, right: number, bottom: number, variant: LayoutVariant): GridGeometry => {
    // A crop within the known grid leaves the detected division spacing intact.
    const x = detected && cropFollowsGridAxis(left, right, detected.left, detected.right, detected.centerX, detected.pxPerHDiv)
      ? detected : null;
    const y = detected && cropFollowsGridAxis(top, bottom, detected.top, detected.bottom, detected.centerY, detected.pxPerVDiv)
      ? detected : null;
    const h = divisions(overrides.hDivs, x?.hDivs ?? 10);
    const v = divisions(overrides.vDivs, y?.vDivs ?? 8);
    const grid = makeGrid(left, top, right, bottom, h, v, variant, invert(left, top, right, bottom));
    return {
      ...grid,
      ...(x && h === x.hDivs && { centerX: x.centerX, vLines: x.vLines.filter(line => line >= left && line <= right), pxPerHDiv: x.pxPerHDiv }),
      ...(y && v === y.vDivs && { centerY: y.centerY, hLines: y.hLines.filter(line => line >= top && line <= bottom), pxPerVDiv: y.pxPerVDiv }),
    };
  };

  if (crop && [crop.x, crop.y, crop.width, crop.height].every(finite) && crop.width > 0 && crop.height > 0) {
    const left = bound(crop.x, width - 2);
    const top = bound(crop.y, height - 2);
    const right = Math.max(Math.min(left + 1, width - 1), bound(crop.x + crop.width, width - 1));
    const bottom = Math.max(Math.min(top + 1, height - 1), bound(crop.y + crop.height, height - 1));
    return build(left, top, right, bottom, 'manual');
  }

  if (detected) return build(detected.left, detected.top, detected.right, detected.bottom, 'standard');

  const dark: PixelPredicate = (r, g, b) => luminance(r, g, b) < 38;
  const longest = (size: number, test: (index: number) => boolean): [number, number] => {
    let start = 0;
    let best: [number, number] = [0, 0];
    for (let i = 0; i <= size; i++) {
      if (i < size && test(i)) continue;
      if (i - start > best[1] - best[0]) best = [start, i];
      start = i + 1;
    }
    return best;
  };
  const middleX = Math.floor(width / 4);
  const colors = colorsFor('universal-fallback');
  const darkOrTrace: PixelPredicate = (r, g, b) => dark(r, g, b) || channelColor(r, g, b, colors) >= 0;
  const [t, b] = longest(height, y => proportion(image,
    { x: middleX, y, width: width - middleX * 2, height: 1 }, darkOrTrace, 3) > 0.62);
  const [l, r] = b > t ? longest(width, x => proportion(image,
    { x, y: t, width: 1, height: b - t }, dark, 3) > 0.66) : [0, 0];
  const bounds: [number, number, number, number] = b - t >= height / 3 && r - l >= width / 3
    ? [l, t, r - 1, b - 1] : [0, 0, width - 1, height - 1];
  return build(...bounds, 'standard');
}

export function detectProfile(image: RgbaImage, overrides: ExtractionOverrides = {}): ProfileDetection {
  if (!int(image.width) || !int(image.height) || image.width < 1 || image.height < 1
      || image.data.length !== image.width * image.height * 4) throw new Error('Invalid RGBA capture dimensions');
  let fallbackReason = 'unsupported_resolution';
  if (overrides.manualCrop || overrides.profileId === 'universal-fallback') {
    fallbackReason = overrides.manualCrop ? 'manual_crop' : 'manual_profile';
  } else {
    for (const p of profiles) {
      if (p.width !== image.width || p.height !== image.height || (overrides.profileId && overrides.profileId !== p.id)) continue;
      const inverted = p.supportsInverted && proportion(image, p.anchors.topBarRoi, (r, g, b) => luminance(r, g, b) > 175, 4) > 0.5;
      fallbackReason = 'native_anchors_mismatch';
      const siglent = p.id === 'siglent-sds2000x-plus';
      const compact = siglent && hasCompactSiglentHeader(image, inverted);
      if (!compact && !logoMatch(image, p, inverted)) continue;
      const barBackground: PixelPredicate = (r, g, b) => siglent
        ? (inverted ? grayscale(r, g, b, 180, 245) : grayscale(r, g, b, 12, 74)) : luminance(r, g, b) < 46;
      if (proportion(image, p.anchors.topBarRoi, p.raster ? rgbNear(p.raster.headerInk) : barBackground, 4) < 0.5
          || proportion(image, p.anchors.bottomBarRoi, p.raster ? rgbNear(p.raster.footerInk) : barBackground, 4) < 0.5) continue;
      const detected = p.raster ? findRasterPlot(image, p, p.raster) : findPlot(image, p, inverted, compact);
      if (!detected) continue;
      const h = divisions(overrides.hDivs, detected.hDivs), v = divisions(overrides.vDivs, detected.vDivs);
      // A cropped plot can have a horizontal pitch and center outside its visible bounds,
      // so rebuild divisions across the full graticule and clip back to the visible right edge.
      const cropped = detected.left + detected.pxPerHDiv * detected.hDivs - detected.right > 0.5;
      const fullRight = cropped ? Math.round(detected.left + detected.pxPerHDiv * detected.hDivs) : detected.right;
      const full = h === detected.hDivs && v === detected.vDivs ? null
        : makeGrid(detected.left, detected.top, fullRight, detected.bottom, h, v,
          detected.layoutVariant, detected.inverted, detected.fitErrorPx);
      const grid = !full || !cropped ? full ?? detected : {
        ...full, right: detected.right, width: detected.width, vLines: full.vLines.filter(x => x <= detected.right),
      };
      const cards = findNativeCards(image, p, inverted, compact);
      const digitalOnly = cards.digital && !cards.analog.size;
      return {
        profileId: p.id, profileName: p.name, matchedAnchors: ['dimensions', 'logo', 'header', 'bottom_bar', 'graticule'],
        confidence: 1, fallbackReason: null, grid, digitalOnly, warnings: digitalOnly ? ['digital_only'] : [],
      };
    }
  }
  const hantek = hantekGrid(image);
  return {
    profileId: 'universal-fallback', profileName: 'Universal Fallback', matchedAnchors: [], confidence: 0,
    ...(hantek && { fallbackLayout: 'hantek-800x480' as const }),
    fallbackReason, grid: fallbackGrid(image, overrides, hantek), digitalOnly: false, warnings: [fallbackReason],
  };
}
