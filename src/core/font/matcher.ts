import { pixelMatches } from '../pixels.js';
import type { PixelPredicate } from '../pixels.js';
import type { Rect, RgbaImage } from '../types.js';

export type BitmapFont = Readonly<Record<string, string>>;

function columnsToGlyph(columns: readonly number[]): string {
  const all = columns.reduce((bits, column) => bits | column, 0);
  const first = 31 - Math.clz32(all & -all);
  const last = 31 - Math.clz32(all);
  const rows: string[] = [];
  for (let y = first; y <= last; y++) {
    rows.push(columns.map(column => column & (1 << y) ? '#' : '.').join(''));
  }
  return rows.join('/');
}

export function readBitmap(image: RgbaImage, box: Rect, foreground: PixelPredicate): string[] {
  const glyphs: string[] = [];
  let columns: number[] = [];
  for (let x = box.x; x <= box.x + box.width; x++) {
    let column = 0;
    if (x < box.x + box.width) {
      for (let y = 0; y < box.height; y++) {
        if (pixelMatches(image, x, box.y + y, foreground)) column |= 1 << y;
      }
    }
    if (column) columns.push(column);
    else if (columns.length) {
      glyphs.push(columnsToGlyph(columns));
      columns = [];
    }
  }
  return glyphs;
}

export function matchBitmap(glyphs: readonly string[], font: BitmapFont): string {
  return glyphs.map(glyph => font[glyph] ?? '?').join('');
}

const unitFactors: Readonly<Record<string, number>> = {
  uV: 1e-6, mV: 1e-3, V: 1,
  ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1,
  Hz: 1, kHz: 1e3, MHz: 1e6, '%': 1,
};

export function parseQuantity(text: string): { readonly value: number; readonly unit: string } | null {
  const match = /^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))(uV|mV|V|ns|us|ms|s|Hz|kHz|MHz|%)$/
    .exec(text.replace(/\s+/g, '').replace(/[µμ]/g, 'u').replace(/−/g, '-'));
  if (!match) return null;
  const unit = match[2]!;
  const value = Number(match[1]!.replace(',', '.')) * unitFactors[unit]!;
  return Number.isFinite(value) ? { value, unit } : null;
}
