import { matchBitmap, parseQuantity, readBitmap } from './font/matcher.js';
import { compactGlyphs, glyphs as siglentFont, labels as siglentLabels } from './font/siglentFont.js';
import { glyphs as rigolFont } from './font/rigolFont.js';
import { rasterFonts } from './font/rasterFonts.js';
import { CHANNELS, pixelMatches } from './pixels.js';
import { findNativeCards, getNativeProfile, hasCompactSiglentHeader, invertTraceColors, isRasterProfile, rigolCardInk, rigolScaleRoi } from './profiles.js';
import type { ChannelColor, PixelPredicate } from './pixels.js';
import type { ChannelId, ChannelSettings, ProfileDetection, Rect, RgbaImage, ScopeMeasureReading } from './types.js';

interface CardReading {
  readonly voltsPerDiv: number | null;
  readonly offsetVolts: number | null;
  readonly probeAttenuation: number;
  readonly coupling: ChannelSettings['coupling'];
  readonly rawScaleText: string | null;
  readonly rawOffsetText: string | null;
}

export interface ScopeMetadata {
  readonly cards: ReadonlyMap<ChannelId, CardReading>;
  readonly secPerDiv: number | null;
  readonly triggerOffsetSec: number | null;
  readonly rawTimebase: string | null;
  readonly topFrequencyHz: number | null;
  readonly topFrequencyRaw: string | null;
  readonly scopeReadings: readonly ScopeMeasureReading[];
  readonly colors?: readonly ChannelColor[];
  readonly digital?: boolean;
  readonly unsupportedChannels?: ReadonlySet<ChannelId>;
}

const measureMetrics: Readonly<Record<string, ScopeMeasureReading['metric']>> = {
  'pk-pk': 'vpp', vpp: 'vpp', max: 'vmax', min: 'vmin', mean: 'vavg', avg: 'vavg', rms: 'vrms',
  amplitude: 'amplitude', freq: 'freq', period: 'period', duty: 'duty', '+duty': 'duty', '-duty': '-duty',
};

const color: PixelPredicate = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 85;
const rigolWhite: PixelPredicate = (r, g, b) => r >= 235 && g >= 240 && b >= 235;
const box = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

function parseScale(text: string | null, unit: 'V' | 's'): number | null {
  if (!text) return null;
  const quantity = parseQuantity(text.replace(/\/(?:div)?$/, ''));
  return quantity && quantity.unit.endsWith(unit) && quantity.value > 0 ? quantity.value : null;
}

function analogColor(channel: ChannelId, r: number, g: number, b: number): boolean {
  if (channel === 'C1') return Math.min(r, g) - b > 65;
  if (channel === 'C2') return r - g > 65 && b - g > 40;
  if (channel === 'C3') return Math.min(g, b) - r > 65;
  return g - Math.max(r, b) > 65;
}

function inferChannel(image: RgbaImage, roi: Rect, inverted: boolean): ChannelId | null {
  let best: ChannelId | null = null;
  let most = 0;
  for (const channel of CHANNELS) {
    const n = readBitmap(image, roi, (r, g, b) => inverted
      ? analogColor(channel, 255 - r, 255 - g, 255 - b)
      : analogColor(channel, r, g, b)).length;
    if (n > most) {
      most = n;
      best = channel;
    }
  }
  return best;
}

function readRasterMetadata(image: RgbaImage, profile: NonNullable<ReturnType<typeof getNativeProfile>>,
  id: keyof typeof rasterFonts): ScopeMetadata {
  if (id === 'siglent-sds800x-hd' || id === 'keysight-dsox1000') return readNewRasterMetadata(image, profile, id);
  const siglent = id === 'siglent-sds1000x-e';
  const rigol = id === 'rigol-dho924';
  const tek = id === 'tektronix-dpo7104c';
  const threshold = siglent ? 145 : rigol ? 165 : tek ? 150 : 175;
  const white = (min: number): PixelPredicate => (r, g, b) => Math.min(r, g, b) >= min;
  const yellow: PixelPredicate = (r, g, b) => r >= 157 && g >= 157 && b < 130;
  const read = (area: Rect, foreground = white(threshold)) => {
    const text = matchBitmap(readBitmap(image, area, foreground), rasterFonts[id].glyphs);
    return text && !text.includes('?') ? text : null;
  };
  const cards = new Map<ChannelId, CardReading>();
  for (const [channel] of findNativeCards(image, profile, false).analog) {
    const rawScaleText = siglent ? read(box(757, 162, 43, 16)) : rigol ? read(box(136, 532, 49, 17), yellow)
      : tek ? read(box(63, 469, 83, 16), white(128))
        : read(channel === 'C1' ? box(80, 790, 49, 27) : box(270, 790, 64, 27));
    const rawOffsetText = siglent ? read(box(757, 179, 43, 15)) : rigol ? read(box(136, 550, 49, 17)) : null;
    const probeText = siglent ? read(box(719, 162, 37, 16)) : null;
    const attenuation = /^(\d+(?:\.\d+)?)X$/.exec(probeText ?? '');
    cards.set(channel, {
      voltsPerDiv: parseScale(rawScaleText, 'V'), offsetVolts: parseQuantity(rawOffsetText ?? '')?.value ?? null,
      rawScaleText, rawOffsetText, probeAttenuation: attenuation ? Number(attenuation[1]) : 1, coupling: 'UNKNOWN',
    });
  }
  const rawTimebase = read(profile.timebaseCard.scaleRoi);
  const delay = tek ? null : read(profile.timebaseCard.delayRoi);
  const topFrequencyRaw = siglent ? read(box(695, 1, 105, 16), (r, g, b) => r > 130 && g > 130 && b < 75) : null;
  const topFrequencyHz = topFrequencyRaw?.startsWith('f=') ? parseQuantity(topFrequencyRaw.slice(2))?.value ?? null : null;
  return {
    cards, secPerDiv: parseScale(rawTimebase, 's'), triggerOffsetSec: parseQuantity(delay ?? '')?.value ?? null,
    rawTimebase, topFrequencyHz, topFrequencyRaw, scopeReadings: [],
  };
}

function readNewRasterMetadata(image: RgbaImage, profile: NonNullable<ReturnType<typeof getNativeProfile>>,
  id: 'siglent-sds800x-hd' | 'keysight-dsox1000'): ScopeMetadata {
  const sds800 = id === 'siglent-sds800x-hd';
  const read = (roi: Rect) => {
    const text = matchBitmap(readBitmap(image, roi, (r, g, b) => Math.min(r, g, b) > 170), rasterFonts[id].glyphs);
    return text && !text.includes('?') ? text : null;
  };
  const cards = new Map<ChannelId, CardReading>();
  for (const [channel, slot] of findNativeCards(image, profile, false).analog) {
    const rawScaleText = read(sds800 ? box(slot.x + 42, 557, 74, 16) : box(slot.x + 21, slot.y, 51, slot.height));
    const voltsPerDiv = parseScale(rawScaleText, 'V');
    const rawOffsetText = sds800 ? read(box(slot.x + 42, 575, 74, 16)) : null;
    const probeText = sds800 ? read(box(slot.x, 557, 40, 16)) : null;
    const attenuation = Number(/^(\d+(?:\.\d+)?)X$/.exec(probeText ?? '')?.[1]);
    const offset = parseQuantity(rawOffsetText ?? '');
    cards.set(channel, {
      voltsPerDiv, offsetVolts: offset?.unit.endsWith('V') ? offset.value : null, rawScaleText, rawOffsetText,
      probeAttenuation: Number.isFinite(attenuation) && attenuation > 0 ? attenuation : 1, coupling: 'UNKNOWN',
    });
  }
  const rawTimebase = read(profile.timebaseCard.scaleRoi);
  const secPerDiv = parseScale(rawTimebase, 's');
  const delay = parseQuantity(read(profile.timebaseCard.delayRoi) ?? '');
  let triggerOffsetSec = delay?.unit.endsWith('s') ? delay.value : null;
  if (sds800 && secPerDiv !== null) {
    // The delay card is relative to the trigger marker, which need not be at the graticule center.
    const row = profile.graticule.top + 1;
    const marks: number[] = [];
    for (let x = profile.graticule.left; x <= profile.graticule.right; x++) {
      if (pixelMatches(image, x, row, (r, g, b) => r === 128 && g === 128 && b === 255)) marks.push(x);
    }
    if (marks.length >= 5 && marks.at(-1)! - marks[0]! < 24) {
      const markerX = Math.round((marks[0]! + marks.at(-1)!) / 2);
      const centerX = (profile.graticule.left + profile.graticule.right) / 2;
      triggerOffsetSec = (triggerOffsetSec ?? 0) + (centerX - markerX) / profile.graticule.pxPerHDiv * secPerDiv;
    }
  }
  return { cards, secPerDiv, triggerOffsetSec, rawTimebase, topFrequencyHz: null, topFrequencyRaw: null, scopeReadings: [] };
}

export function readScopeMetadata(image: RgbaImage, detection: ProfileDetection): ScopeMetadata {
  const profile = getNativeProfile(detection.profileId);
  const cards = new Map<ChannelId, CardReading>();
  if (!profile) {
    return { cards, secPerDiv: null, triggerOffsetSec: null, rawTimebase: null, topFrequencyHz: null, topFrequencyRaw: null, scopeReadings: [] };
  }
  if (isRasterProfile(profile.id)) return readRasterMetadata(image, profile, profile.id);
  const { layoutVariant, inverted } = detection.grid;
  const siglent = profile.id === 'siglent-sds2000x-plus';
  const compact = siglent && hasCompactSiglentHeader(image, inverted);
  const native = findNativeCards(image, profile, inverted, compact);
  const invertColors = invertTraceColors(image, profile.id, inverted);
  const unsupportedChannels = new Set<ChannelId>();
  const ink: PixelPredicate = siglent
    ? (r, g, b) => inverted ? 255 - Math.max(r, g, b) >= (compact ? 158 : 250)
      : Math.min(r, g, b) >= (compact ? 158 : 250)
    : rigolWhite;
  const font = compact ? compactGlyphs : siglent ? siglentFont : rigolFont;
  const read = (area: Rect, foreground: PixelPredicate = ink) => matchBitmap(readBitmap(image, area, foreground), font) || null;
  for (const [channel, slot] of native.analog) {
    if (compact) {
      const rawScaleText = read(box(slot.x + 48, 559, 52, 17));
      const rawOffsetText = read(box(slot.x + 48, 577, 52, 17));
      if (rawScaleText?.endsWith('A/') || rawOffsetText?.endsWith('A')) {
        unsupportedChannels.add(channel);
        continue;
      }
      cards.set(channel, {
        voltsPerDiv: parseScale(rawScaleText, 'V'), offsetVolts: parseQuantity(rawOffsetText ?? '')?.value ?? null,
        rawScaleText, rawOffsetText, probeAttenuation: 1, coupling: 'UNKNOWN',
      });
    } else if (siglent) {
      const rawScaleText = read(box(slot.x + 55, 560, 65, 13));
      const rawOffsetText = read(box(slot.x + 55, 577, 65, 15));
      const probeText = read(box(slot.x + 1, 560, 39, 13));
      const couplingText = read(box(slot.x + 65, 543, 54, 13), (r, g, b) => invertColors
        ? analogColor(channel, 255 - r, 255 - g, 255 - b) : analogColor(channel, r, g, b));
      const attenuation = /^(\d+(?:\.\d+)?)X$/.exec(probeText ?? '');
      cards.set(channel, {
        voltsPerDiv: parseScale(rawScaleText, 'V'), offsetVolts: parseQuantity(rawOffsetText ?? '')?.value ?? null,
        rawScaleText, rawOffsetText, probeAttenuation: attenuation ? Number(attenuation[1]) : 1,
        coupling: /^(DC|AC|GND)/.exec(couplingText ?? '')?.[1] as ChannelSettings['coupling'] ?? 'UNKNOWN',
      });
    } else {
      const rawScaleText = read(rigolScaleRoi(slot), rigolCardInk(profile.channels[channel]!));
      cards.set(channel, {
        voltsPerDiv: parseScale(rawScaleText, 'V'), offsetVolts: null, rawScaleText, rawOffsetText: null,
        probeAttenuation: 1, coupling: 'UNKNOWN',
      });
    }
  }
  const rawTimebase = compact ? read(box(753, 559, 73, 17))
    : siglent ? read(box(727, 560, 77, 13)) : read(profile.timebaseCard.scaleRoi);
  const delay = read(compact ? box(697, 559, 51, 17)
    : siglent ? box(664, 560, 62, 13) : profile.timebaseCard.delayRoi);
  const topFrequencyRaw = !compact && profile.topFrequencyRoi ? read(profile.topFrequencyRoi, color) : null;
  const top = /^f\((C[1-4])\)=([\d.,]+(?:[kM]?Hz))$/.exec(topFrequencyRaw ?? '');
  const topFrequencyHz = top ? parseQuantity(top[2]!)?.value ?? null : null;
  const scopeReadings: ScopeMeasureReading[] = [];

  if (siglent && !compact && (layoutVariant === 'measure-1row' || layoutVariant === 'measure-2row')) {
    const twoRows = layoutVariant === 'measure-2row';
    for (let i = 0; i < (twoRows ? 5 : 4); i++) {
      const x = twoRows ? 181 + i * 163 : 10 + i * 246;
      const labelRoi = box(x, twoRows ? 492 : 511, 112, 17);
      const tokens = readBitmap(image, labelRoi, color);
      const label = siglentLabels[tokens.join(' ')] ?? matchBitmap(tokens, siglentFont);
      if (!label || label.includes('?')) continue;
      const rawText = read(box(twoRows ? x : x + 121, twoRows ? 512 : 511, 112, twoRows ? 15 : 17));
      if (!rawText) continue;
      const suffix = /\((C[1-4])\)$/.exec(label);
      const channel = detection.digitalOnly || rawText === '***' ? null
        : (suffix?.[1] as ChannelId | undefined) ?? inferChannel(image, labelRoi, invertColors);
      const metric = measureMetrics[label.replace(/\(.*\)$/, '').toLowerCase()] ?? 'other';
      const quantity = parseQuantity(rawText);
      scopeReadings.push({ label, metric, channel, rawText, value: quantity?.value ?? null, unit: quantity?.unit ?? '' });
    }
  }

  return {
    cards, secPerDiv: parseScale(rawTimebase, 's'), triggerOffsetSec: parseQuantity(delay ?? '')?.value ?? null,
    rawTimebase, topFrequencyHz, topFrequencyRaw, scopeReadings, colors: native.colors, digital: native.digital, unsupportedChannels,
  };
}
