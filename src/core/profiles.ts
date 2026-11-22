import data from './profiles.json' with { type: 'json' };
import { matchBitmap, readBitmap } from './font/matcher.js';
import { compactBadgeGlyphs, logo as siglentLogo } from './font/siglentFont.js';
import { logo as rigolLogo } from './font/rigolFont.js';
import { at, CHANNELS, channelColor, hueDegrees, pixelMatches } from './pixels.js';
import type { ChannelColor, PixelPredicate } from './pixels.js';
import type { ChannelId, ExtractionOverrides, GridGeometry, LayoutVariant, ProfileDetection, ProfileId, Rect, RgbaImage } from './types.js';

interface NativeVariant {
  readonly id: Exclude<LayoutVariant, 'manual'>;
  readonly bottom: number;
  readonly pxPerVDiv: number;
  readonly measureBar: (Rect & { readonly rows: number }) | null;
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
  readonly channels: Readonly<Record<ChannelId, ChannelColor>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown): v is number => finite(v) && Number.isInteger(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;

export function validateProfiles(value: unknown): readonly NativeProfile[] {
  function validProfile(p: unknown): p is NativeProfile {
    if (!isRecord(p) || (p.id !== 'siglent-sds2000x-plus' && p.id !== 'rigol-ds1054z')
        || typeof p.name !== 'string' || !p.name.trim() || !int(p.width) || p.width < 1
        || !int(p.height) || p.height < 1 || typeof p.supportsInverted !== 'boolean') return false;
    const { width, height } = p;
    function rect(r: unknown): r is Rect {
      return isRecord(r) && int(r.x) && int(r.y) && int(r.width) && int(r.height)
        && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
        && r.x + r.width <= width && r.y + r.height <= height;
    }
    const { anchors, graticule: g, timebaseCard: t, channels } = p;
    if (!isRecord(anchors) || !rect(anchors.logoRoi) || !rect(anchors.topBarRoi) || !rect(anchors.bottomBarRoi)
        || !rect(p.zeroMarkerStrip) || (p.topFrequencyRoi !== null && !rect(p.topFrequencyRoi))
        || !isRecord(t) || !rect(t.box) || !rect(t.scaleRoi) || !rect(t.delayRoi)
        || !isRecord(channels) || !Array.isArray(p.channelCardSlots) || p.channelCardSlots.length !== 4
        || !p.channelCardSlots.every((s: unknown, i) => isRecord(s) && s.slot === i && rect(s))) return false;
    if (!isRecord(g) || !int(g.left) || !int(g.right) || !int(g.top) || g.left < 0 || g.right <= g.left
        || g.right >= width || g.top < 0 || g.top >= height || !int(g.hDivs) || g.hDivs < 1
        || !int(g.vDivs) || g.vDivs < 1 || !positive(g.pxPerHDiv)
        || g.pxPerHDiv * g.hDivs !== g.right - g.left || !Array.isArray(g.variants)) return false;
    const variants = p.id === 'rigol-ds1054z' ? ['standard', 'measure-1row', 'fft'] : ['no-measure', 'measure-1row', 'measure-2row'];
    const { top, vDivs } = g;
    if (g.variants.length !== variants.length || !g.variants.every((v: unknown, i) =>
      isRecord(v) && v.id === variants[i] && int(v.bottom) && v.bottom > top && v.bottom < height
      && positive(v.pxPerVDiv) && v.pxPerVDiv * vDivs === v.bottom - top
      && (v.id === 'no-measure' || v.id === 'fft' ? v.measureBar === null
        : isRecord(v.measureBar) && v.measureBar.rows === (v.id === 'measure-2row' ? 2 : 1) && rect(v.measureBar)))) return false;
    return CHANNELS.every(id => {
      const c = channels[id];
      return isRecord(c) && Array.isArray(c.rgb) && c.rgb.length === 3
        && c.rgb.every((level: unknown) => int(level) && level >= 0 && level <= 255)
        && finite(c.hueMin) && finite(c.hueMax) && c.hueMin >= 0 && c.hueMax <= 360 && c.hueMin <= c.hueMax
        && positive(c.satMin) && c.satMin <= 1 && positive(c.valMin) && c.valMin <= 1;
    });
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length !== 2
      || !value.profiles.every(validProfile) || new Set(value.profiles.map(p => p.id)).size !== 2) {
    throw new Error('Invalid oscilloscope profile configuration');
  }
  return value.profiles;
}

const profiles = validateProfiles(data);
export const getNativeProfile = (id: ProfileId) => profiles.find(p => p.id === id);
export const colorsFor = (id: ProfileId) => CHANNELS.map(channel => (getNativeProfile(id) ?? profiles[0]!).channels[channel]);

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
  if (p.id === 'siglent-sds2000x-plus') return logoOverlap(image, roi, siglentLogo, siglentLogoInk(inverted)) >= 0.78;
  return logoOverlap(image, roi, rigolLogo, (r, g, b) => Math.min(r, g) - b >= 52) >= 0.78
    || logoOverlap(image, { ...roi, x: roi.x - 1, y: roi.y + 1 }, rigolLogo,
      (r, g, b) => b - Math.max(r, g) >= 65) >= 0.65;
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

function findCompactSiglentCards(image: RgbaImage, inverted: boolean): NativeCards {
  const analog = new Map<ChannelId, Rect>();
  const colors = colorsFor('siglent-sds2000x-plus').map(color => ({ ...color, valMin: 2 }));
  let digital = false;
  for (let x = 4; x <= 420; x += 104) {
    const index = at(image, x + 32, 550);
    const rgb = Array.from(image.data.subarray(index, index + 3), value => inverted ? 255 - value : value);
    const high = Math.max(...rgb);
    const spread = high - Math.min(...rgb);
    if (high < 140 || spread < 90) continue;
    const component = rgb.indexOf(high);
    const label = matchBitmap(readBitmap(image, { x: x + 3, y: 544, width: 31, height: 12 },
      (...levels) => (inverted ? 255 - levels[component]! : levels[component]!) < high * 0.7), compactBadgeGlyphs);
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
  if (compact) return findCompactSiglentCards(image, inverted);
  const analog = new Map<ChannelId, Rect>();
  let digital = false;
  const colors = colorsFor(profile.id);
  for (const [i, slot] of profile.channelCardSlots.entries()) {
    if (profile.id === 'rigol-ds1054z') {
      const color = colors[i]!;
      const active = proportion(image, rigolScaleRoi(slot), rigolCardInk(color));
      if (active > 0.035) analog.set(CHANNELS[i]!, slot);
      continue;
    }
    const badge = { x: slot.x + 1, y: slot.y + 2, width: 42, height: 12 };
    const blue: PixelPredicate = (r, g, b) => inverted
      ? r > 210 && g > 159 && g < 201 && b > 17 && b < 62
      : b > 193 && g > 57 && g < 94 && r < 45;
    if (proportion(image, badge, blue) > 0.65) {
      digital = true;
      continue;
    }
    for (const [index, id] of CHANNELS.entries()) {
      if (proportion(image, badge, (r, g, b) => (inverted
        ? channelColor(255 - r, 255 - g, 255 - b, colors) : channelColor(r, g, b, colors)) === index) > 0.65) {
        analog.set(id, slot);
        break;
      }
    }
  }
  return { analog, digital };
}

const divisions = (n: number | undefined, fallback: number) => int(n) && n >= 1 && n <= 100 ? n : fallback;

function fallbackGrid(image: RgbaImage, overrides: ExtractionOverrides): GridGeometry {
  const bound = (value: number, max: number) => Math.min(Math.max(0, max), Math.max(0, Math.round(value)));
  const { width, height } = image;
  const crop = overrides.manualCrop;
  const h = divisions(overrides.hDivs, 10);
  const v = divisions(overrides.vDivs, 8);
  const invert = (l: number, t: number, r: number, b: number) => proportion(image,
    { x: l, y: t, width: Math.max(1, r - l), height: Math.max(1, b - t) }, (r, g, b) => luminance(r, g, b) > 210, 5) > 0.6;

  if (crop && [crop.x, crop.y, crop.width, crop.height].every(finite) && crop.width > 0 && crop.height > 0) {
    const left = bound(crop.x, width - 2);
    const top = bound(crop.y, height - 2);
    const right = Math.max(Math.min(left + 1, width - 1), bound(crop.x + crop.width, width - 1));
    const bottom = Math.max(Math.min(top + 1, height - 1), bound(crop.y + crop.height, height - 1));
    return makeGrid(left, top, right, bottom, h, v, 'manual', invert(left, top, right, bottom));
  }

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
  const [t, b] = longest(height, y => proportion(image,
    { x: middleX, y, width: width - middleX * 2, height: 1 }, dark, 3) > 0.62);
  const [l, r] = b > t ? longest(width, x => proportion(image,
    { x, y: t, width: 1, height: b - t }, dark, 3) > 0.66) : [0, 0];
  const bounds: [number, number, number, number] = b - t >= height / 3 && r - l >= width / 3
    ? [l, t, r - 1, b - 1] : [0, 0, width - 1, height - 1];
  return makeGrid(...bounds, h, v, 'standard', invert(...bounds));
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
      if (proportion(image, p.anchors.topBarRoi, barBackground, 4) < 0.5
          || proportion(image, p.anchors.bottomBarRoi, barBackground, 4) < 0.5) continue;
      const grid = findPlot(image, p, inverted, compact);
      if (!grid) continue;
      const cards = findNativeCards(image, p, inverted, compact);
      const digitalOnly = cards.digital && !cards.analog.size;
      return {
        profileId: p.id, profileName: p.name, matchedAnchors: ['dimensions', 'logo', 'header', 'bottom_bar', 'graticule'],
        confidence: 1, fallbackReason: null, grid, digitalOnly, warnings: digitalOnly ? ['digital_only'] : [],
      };
    }
  }
  return {
    profileId: 'universal-fallback', profileName: 'Universal Fallback', matchedAnchors: [], confidence: 0,
    fallbackReason, grid: fallbackGrid(image, overrides), digitalOnly: false, warnings: [fallbackReason],
  };
}
