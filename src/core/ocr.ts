import { matchBitmap, parseQuantity, readBitmap } from './font/matcher.js';
import { compactGlyphs, glyphs as siglentFont, labels as siglentLabels } from './font/siglentFont.js';
import { glyphs as rigolFont } from './font/rigolFont.js';
import { CHANNELS } from './pixels.js';
import { findNativeCards, getNativeProfile, hasCompactSiglentHeader, rigolCardInk, rigolScaleRoi } from './profiles.js';
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
  readonly unsupportedChannels?: ReadonlySet<ChannelId>;
}

const measureMetrics: Readonly<Record<string, ScopeMeasureReading['metric']>> = {
  'pk-pk': 'vpp', vpp: 'vpp', max: 'vmax', min: 'vmin', mean: 'vavg', avg: 'vavg', rms: 'vrms',
  amplitude: 'amplitude', freq: 'freq', period: 'period', duty: 'duty', '+duty': 'duty', '-duty': 'duty',
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

export function readScopeMetadata(image: RgbaImage, detection: ProfileDetection): ScopeMetadata {
  const profile = getNativeProfile(detection.profileId);
  const cards = new Map<ChannelId, CardReading>();
  if (!profile) {
    return { cards, secPerDiv: null, triggerOffsetSec: null, rawTimebase: null, topFrequencyHz: null, topFrequencyRaw: null, scopeReadings: [] };
  }
  const { layoutVariant, inverted } = detection.grid;
  const siglent = profile.id === 'siglent-sds2000x-plus';
  const compact = siglent && hasCompactSiglentHeader(image, inverted);
  const native = findNativeCards(image, profile, inverted, compact);
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
      const couplingText = read(box(slot.x + 65, 543, 54, 13), (r, g, b) => inverted
        ? analogColor(channel, 255 - r, 255 - g, 255 - b) : analogColor(channel, r, g, b));
      const attenuation = /^(\d+(?:\.\d+)?)X$/.exec(probeText ?? '');
      cards.set(channel, {
        voltsPerDiv: parseScale(rawScaleText, 'V'), offsetVolts: parseQuantity(rawOffsetText ?? '')?.value ?? null,
        rawScaleText, rawOffsetText, probeAttenuation: attenuation ? Number(attenuation[1]) : 1,
        coupling: /^(DC|AC|GND)/.exec(couplingText ?? '')?.[1] as ChannelSettings['coupling'] ?? 'UNKNOWN',
      });
    } else {
      const rawScaleText = read(rigolScaleRoi(slot), rigolCardInk(profile.channels[channel]));
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
        : (suffix?.[1] as ChannelId | undefined) ?? inferChannel(image, labelRoi, inverted);
      const metric = measureMetrics[label.replace(/\(.*\)$/, '').toLowerCase()] ?? 'other';
      const quantity = parseQuantity(rawText);
      scopeReadings.push({ label, metric, channel, rawText, value: quantity?.value ?? null, unit: quantity?.unit ?? '' });
    }
  }

  return {
    cards, secPerDiv: parseScale(rawTimebase, 's'), triggerOffsetSec: parseQuantity(delay ?? '')?.value ?? null,
    rawTimebase, topFrequencyHz, topFrequencyRaw, scopeReadings, colors: native.colors, unsupportedChannels,
  };
}
