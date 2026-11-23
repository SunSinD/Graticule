import type { ChannelId, RgbaImage } from './types.js';

export const CHANNELS = ['C1', 'C2', 'C3', 'C4'] as const satisfies readonly ChannelId[];
export const MIN_VISIBLE_ALPHA = 128;

export interface ChannelColor {
  readonly rgb: readonly number[];
  readonly hueMin: number;
  readonly hueMax: number;
  readonly satMin: number;
  readonly valMin: number;
}

export type PixelPredicate = (r: number, g: number, b: number) => boolean;

export const at = (image: RgbaImage, x: number, y: number) => (y * image.width + x) * 4;

export function pixelMatches(image: RgbaImage, x: number, y: number, predicate: PixelPredicate): boolean {
  const index = at(image, x, y);
  return image.data[index + 3]! >= MIN_VISIBLE_ALPHA
    && predicate(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!);
}

export function hueDegrees(r: number, g: number, b: number, high: number, spread: number): number {
  return 60 * (high === r ? (g - b) / spread + (g < b ? 6 : 0)
    : high === g ? 2 + (b - r) / spread : 4 + (r - g) / spread);
}

export function channelColor(r: number, g: number, b: number, colors: readonly ChannelColor[]): number {
  const high = Math.max(r, g, b);
  const spread = high - Math.min(r, g, b);
  if (high < 78 || spread < 29) return -1;
  const degrees = hueDegrees(r, g, b, high, spread);
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i]!;
    const inHue = c.hueMin <= c.hueMax ? degrees >= c.hueMin && degrees <= c.hueMax
      : degrees >= c.hueMin || degrees <= c.hueMax;
    if (inHue && spread >= high * c.satMin && high >= c.valMin * 255) return i;
  }
  return -1;
}
