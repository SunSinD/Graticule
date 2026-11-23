import { at } from './pixels.js';
import type { GridGeometry, ProfileId, RgbaImage } from './types.js';

export const CURSOR = 1;
export const OVERLAY = 2;

export interface OverlayMask {
  readonly pixels: Uint8Array;
  readonly coveragePct: number;
}

interface Run { readonly start: number; readonly end: number }

const YELLOW = 1;
const RED = 2;
const CALLOUT = 4;
const LANE = 8;
const PILL = 16;
const VISITED = 32;
const DIGITAL = 64;

function findRuns(from: number, to: number, ink: (index: number) => boolean): Run[] {
  const runs: Run[] = [];
  let start: number | null = null;
  for (let i = from; i <= to + 1; i++) {
    if (i <= to && ink(i)) start ??= i;
    else if (start !== null) {
      runs.push({ start, end: i - 1 });
      start = null;
    }
  }
  return runs;
}

function hasDashPattern(runs: readonly Run[], span: number): boolean {
  const dashes = runs.filter(run => run.end - run.start >= 2 && run.end - run.start <= 16);
  if (dashes.length < 6 || dashes.at(-1)!.end - dashes[0]!.start < 0.29 * span) return false;
  const frequencies = new Uint16Array(31);
  let most = 0;
  for (let i = 1; i < dashes.length; i++) {
    const previous = dashes[i - 1]!;
    const current = dashes[i]!;
    const stride = current.start - previous.start;
    if (stride < 5 || stride > 30 || Math.abs((previous.end - previous.start) - (current.end - current.start)) > 1) continue;
    frequencies[stride] = frequencies[stride]! + 1;
    most = Math.max(most, frequencies[stride]!);
  }
  return most >= Math.max(5, dashes.length * 0.38);
}

export function buildOverlayMask(image: RgbaImage, grid: GridGeometry, profile: ProfileId, digital = false): OverlayMask {
  const { width, height, data } = image;
  const pixels = new Uint8Array(width * height);
  const features = new Uint8Array(pixels.length);
  const { left, top, right, bottom, inverted } = grid;
  const siglent = profile === 'siglent-sds2000x-plus';
  const has = (x: number, y: number, bit: number) => Boolean((features[y * width + x] ?? 0) & bit);
  const fill = (x1: number, y1: number, x2: number, y2: number, bit: number) => {
    for (let y = Math.max(top, y1); y <= Math.min(bottom, y2); y++) {
      for (let x = Math.max(left, x1); x <= Math.min(right, x2); x++) {
        const i = y * width + x;
        pixels[i] = pixels[i]! | bit;
      }
    }
  };
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = at(image, x, y);
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      let bits = 0;
      if (inverted) {
        if (b <= 9 && ((r >= 172 && r <= 188 && g >= 172 && g <= 188) || (siglent && r >= 245 && g >= 245))) bits |= YELLOW;
        if (r < 10 && g > 245 && b > 245) bits |= RED;
        if (siglent && r === g && g === b && (r === 241 || r === 242)) bits |= CALLOUT;
        if (siglent && r >= 245 && g >= 58 && g <= 69 && b <= 10) bits |= LANE;
        if (siglent && x < left + 23 && (r === 220 || r === 221) && g === 187 && (b === 184 || b === 185)) bits |= PILL;
      } else {
        if (r >= 245 && g >= 245 && b < 12) bits |= YELLOW;
        if (r > 245 && g < 15 && b < 15) bits |= RED;
        if (siglent && r === 14 && g === 14 && b === 14) bits |= CALLOUT;
        if (siglent && r <= 8 && g >= 185 && g <= 198 && b >= 248) bits |= LANE;
        if (siglent && x < left + 23 && r === 35 && g === 68 && b === 70) bits |= PILL;
      }
      if (siglent && digital) {
        const red = inverted ? 255 - r : r, green = inverted ? 255 - g : g, blue = inverted ? 255 - b : b;
        if ((red === 193 && green === 0 && blue === 0) || (red === 205 && green === 80 && blue === 80)) pixels[i / 4] = OVERLAY;
        if (red === 23 && green === 76 && blue === 223) bits |= DIGITAL;
      }
      features[i / 4] = bits;
    }
  }

  for (const horizontal of [true, false]) {
    const start = horizontal ? left : top;
    const end = horizontal ? right : bottom;
    const axisStart = horizontal ? top : left;
    const axisEnd = horizontal ? bottom : right;
    const span = end - start;
    for (let line = axisStart; line <= axisEnd; line++) {
      const runs = (bit: number) => findRuns(start, end, i => horizontal ? has(i, line, bit) : has(line, i, bit));
      const yellowRuns = runs(YELLOW);
      if (hasDashPattern(yellowRuns, span)) {
        for (const run of yellowRuns) {
          if (run.end - run.start > 18) continue;
          if (horizontal) fill(run.start, line, run.end, line, CURSOR);
          else fill(line, run.start, line, run.end, CURSOR);
        }
      }
      if (profile === 'rigol-ds1054z') continue;
      const redRuns = runs(RED);
      if (hasDashPattern(redRuns, span * 0.37)) {
        const first = Math.max(start, redRuns[0]!.start - 3);
        const last = Math.min(end, redRuns.at(-1)!.end + 3);
        for (let i = first; i <= last; i++) {
          for (let d = -7; d <= 7; d++) {
            const x = horizontal ? i : line + d;
            const y = horizontal ? line + d : i;
            if (x >= left && x <= right && y >= top && y <= bottom && has(x, y, RED)) fill(x, y, x, y, CURSOR);
          }
        }
      }
    }
  }

  if (profile === 'rigol-ds1054z') {
    const sameColor = (x: number, y: number, r: number, g: number, b: number) => {
      const i = at(image, x, y);
      return data[i] === r && data[i + 1] === g && data[i + 2] === b;
    };
    if ([545, 590, 640, 665].every(x => sameColor(x, 40, 152, 152, 152) && sameColor(x, 64, 152, 152, 152))) {
      fill(530, 40, 679, 64, OVERLAY);
    }
    if ([197, 300, 470, 582].every(x => sameColor(x, 102, 96, 100, 96) && sameColor(x, 361, 24, 24, 24))
        && [104, 150, 250, 356].every(y => sameColor(190, y, 32, 36, 32) && sameColor(589, y, 32, 36, 32))) {
      fill(190, 102, 589, 361, OVERLAY);
    }
  }

  if (siglent) {
    const callouts: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
    if (digital) {
      const ink = inverted ? 0 : 255;
      const digitalInk = (x: number, y: number) => {
        const i = at(image, x, y);
        return data[i] === ink && data[i + 1] === ink && data[i + 2] === ink;
      };
      for (let y = top; y + 16 <= bottom; y++) {
        const borders = [...findRuns(left, left + 92, x => digitalInk(x, y)),
          ...findRuns(right - 92, right, x => digitalInk(x, y))];
        for (const run of borders) {
          if (run.end - run.start < 15 || (run.start > left + 3 && run.end < right - 3)) continue;
          for (let h = 15; h <= 22 && y + h <= bottom; h++) {
            if (!digitalInk(run.start + 2, y + h) || !digitalInk(run.end - 2, y + h)
                || !digitalInk(run.start, y + (h >> 1)) || !digitalInk(run.end, y + (h >> 1))) continue;
            fill(run.start, y, run.end, y + h, OVERLAY);
            break;
          }
        }
      }
    }
    if (grid.layoutVariant === 'decode-table') {
      const whiteSpan = (y: number) => {
        let count = 0;
        for (let x = left; x <= right; x++) {
          const i = at(image, x, y);
          const ink = inverted ? 0 : 255;
          if (data[i] === ink && data[i + 1] === ink && data[i + 2] === ink) count++;
        }
        return count > grid.width * 0.4;
      };
      for (let y = bottom - 30; y + 18 <= bottom; y++) {
        if (whiteSpan(y) && whiteSpan(y + 18)) fill(left, y, right, y + 18, OVERLAY);
      }
    }

    // A Siglent trigger level badge is a triangle with its long edge at the right border.
    const packed = (x: number, y: number) => {
      const i = at(image, x, y);
      return (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    };
    for (let y = top + 9; y <= bottom - 9; y++) {
      const tip = right - 9;
      const base = right - 1;
      const color = packed(tip, y);
      const levels = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
      if (Math.max(...levels) - Math.min(...levels) < 90 || packed(tip - 1, y) === color
          || packed(tip, y - 2) === color || packed(tip, y + 2) === color
          || packed(base, y - 7) !== color || packed(base, y + 7) !== color) continue;
      for (let dy = -8; dy <= 8; dy++) {
        for (let x = tip + Math.abs(dy); x <= base; x++) {
          if (packed(x, y + dy) === color) fill(x, y + dy, x, y + dy, OVERLAY);
        }
      }
    }

    for (let y = top; y <= bottom; y++) {
      if (y + 18 <= bottom && (has(left, y, YELLOW) || y >= bottom - 28)) {
        const runs = findRuns(left, y >= bottom - 28 ? right : left + 30, x => has(x, y, YELLOW));
        for (const run of runs) {
          if (run.end - run.start < 28 || run.end - run.start > 31
              || !has(run.start, y + 18, YELLOW) || !has(run.end, y + 18, YELLOW)) continue;
          fill(run.start, y, run.end, y + 18, CURSOR);
        }
      }
      if (y > grid.centerY + grid.height * 3 / 16) {
        let lane = 0;
        let pill = 0;
        for (let x = left + 24; x < right; x += 4) if (has(x, y, LANE)) lane++;
        for (let x = left; x < left + 22; x++) if (has(x, y, PILL)) pill++;
        if (lane * 4 > grid.width * 0.34) fill(left, y - 9, right, y + 9, OVERLAY);
        else if (pill >= 11) fill(left, y, left + 22, y, OVERLAY);
      }

      for (let x = left; x <= right; x++) {
        const feature = has(x, y, DIGITAL) ? DIGITAL : CALLOUT;
        if (!has(x, y, feature) || has(x, y, VISITED)) continue;
        const fifo = [y * width + x];
        features[fifo[0]!] = features[fifo[0]!]! | VISITED;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        for (let j = 0; j < fifo.length; j++) {
          const i = fifo[j]!;
          const px = i % width;
          const py = Math.floor(i / width);
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
          for (const next of [i - 1, i + 1, i - width, i + width]) {
            if (((features[next] ?? 0) & (feature | VISITED)) === feature) {
              features[next] = features[next]! | VISITED;
              fifo.push(next);
            }
          }
        }
        const boxWidth = maxX - minX + 1;
        const boxHeight = maxY - minY + 1;
        const pill = feature === DIGITAL && boxWidth >= 12 && boxWidth <= 100 && boxHeight >= 8 && boxHeight <= 24;
        const callout = feature === CALLOUT && boxWidth >= 45 && boxWidth <= 220 && boxHeight >= 13 && boxHeight <= 55;
        if ((pill || callout) && fifo.length >= boxWidth * boxHeight * 0.55) {
          fill(minX, minY, maxX, maxY, OVERLAY);
          if (inverted && callout) callouts.push({ minX, maxX, minY, maxY });
        }
      }
    }
    // A vertical grid line can split an inverted callout into two gray regions
    // and leave yellow ink from the callout exposed along the seam.
    for (const { minX, maxX, minY, maxY } of callouts) {
      for (const x of [minX - 1, maxX + 1]) {
        if (x <= left || x >= right) continue;
        for (let y = minY; y <= maxY; y++) {
          const i = y * width + x;
          if (has(x, y, YELLOW) && (pixels[i - 1]! & pixels[i + 1]! & OVERLAY)) pixels[i] = pixels[i]! | OVERLAY;
        }
      }
    }
  }

  let covered = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) if (pixels[y * width + x]) covered++;
  }
  return { pixels, coveragePct: 100 * covered / ((grid.width + 1) * (grid.height + 1)) };
}
