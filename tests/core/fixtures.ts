import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Rect, RgbaImage } from '../../src/core/types.js';

export type Rgb = readonly [number, number, number];
export const yellow = [255, 255, 57] as const;
export const magenta = [255, 57, 156] as const;

export function bitmap(width: number, height: number, color: Rgb = [0, 0, 0]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

export function pixel(image: RgbaImage, x: number, y: number, color: Rgb): void {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
  image.data.set(color, 4 * (y * image.width + x));
}

export function paint(image: RgbaImage, area: Rect, color: Rgb): void {
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) pixel(image, x, y, color);
  }
}

export function sample(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`../fixtures/samples/${name}`, import.meta.url)));
}
