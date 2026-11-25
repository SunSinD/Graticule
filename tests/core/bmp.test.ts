import { describe, expect, test } from 'vitest';
import { decodeBmp, hasBmpSignature, isSupportedBmpHeader } from '../../src/core/bmp.js';
import { decodeImage } from '../../src/core/png.js';
import { sample } from './fixtures.js';

const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], black = [0, 0, 0, 255];
const palette = [black, red, green, blue];

function bmp(width: number, height: number, depth: number, pixels: number[], options: {
  compression?: number; palette?: number[][]; masks?: number[]; headerSize?: number;
} = {}): Buffer {
  const { compression = 0, palette = [], masks = [], headerSize = 40 } = options;
  const maskBytes = headerSize === 40 ? masks.length * 4 : 0;
  const offset = 14 + headerSize + maskBytes + palette.length * 4;
  const bytes = Buffer.alloc(offset + pixels.length);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(offset, 10);
  bytes.writeUInt32LE(headerSize, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(depth, 28);
  bytes.writeUInt32LE(compression, 30);
  bytes.writeUInt32LE(pixels.length, 34);
  bytes.writeUInt32LE(palette.length, 46);
  masks.forEach((mask, i) => bytes.writeUInt32LE(mask, 54 + i * 4));
  palette.forEach(([r, g, b], i) => bytes.set([b!, g!, r!, 0], 14 + headerSize + maskBytes + i * 4));
  bytes.set(pixels, offset);
  return bytes;
}

describe('BMP decoding', () => {
  test.each([
    [1, [0b01000000, 0, 0, 0], palette.slice(0, 2), [black, red]],
    [4, [0x12, 0, 0, 0], palette, [red, green]],
    [8, [2, 3, 0, 0], palette, [green, blue]],
  ] as const)('decodes %i-bit indexed BMP pixels with padded rows', (depth, pixels, colors, expected) => {
    const bytes = bmp(2, 1, depth, [...pixels], { palette: [...colors] });
    expect(isSupportedBmpHeader(bytes)).toBe(true);
    expect(decodeBmp(bytes).data).toEqual(Uint8ClampedArray.from(expected.flat()));
  });

  test('decodes bottom-up and top-down BGR rows with padding', () => {
    const bottom = [255, 0, 0, 0], top = [0, 0, 255, 0];
    for (const bytes of [bmp(1, 2, 24, [...bottom, ...top]), bmp(1, -2, 24, [...top, ...bottom])]) {
      expect(hasBmpSignature(bytes)).toBe(true);
      expect(decodeImage(bytes)).toEqual({ width: 1, height: 2, data: Uint8ClampedArray.from([...red, ...blue]) });
    }
    expect(decodeImage(sample('sine_schmitt.png')).width).toBe(1024);
    expect(() => decodeImage(Uint8Array.of(1, 2, 3))).toThrow('expected PNG or BMP');
  });

  test('decodes 16-bit RGB555 and explicit RGB565 masks', () => {
    expect(decodeBmp(bmp(2, 1, 16, [0, 124, 224, 3])).data).toEqual(Uint8ClampedArray.from([...red, ...green]));
    const bytes = bmp(2, 1, 16, [0, 248, 224, 7], { compression: 3, masks: [0xf800, 0x07e0, 0x001f] });
    expect(decodeBmp(bytes).data).toEqual(Uint8ClampedArray.from([...red, ...green]));
  });

  test('decodes 32-bit BGRX as opaque and honors explicit alpha masks', () => {
    expect(decodeBmp(bmp(1, 1, 32, [0, 0, 255, 0])).data).toEqual(Uint8ClampedArray.from(red));
    const masks = [0xff0000, 0xff00, 0xff, 0xff000000];
    for (const headerSize of [40, 56, 108, 124]) {
      const bytes = bmp(1, 1, 32, [0, 0, 255, 128], { compression: 3, masks, headerSize });
      expect(decodeBmp(bytes).data).toEqual(Uint8ClampedArray.of(255, 0, 0, 128));
    }
  });

  test('treats an all-zero explicit alpha channel as opaque but keeps partial alpha', () => {
    const masks = [0xff0000, 0xff00, 0xff, 0xff000000];
    const zero = bmp(2, 1, 32, [0, 0, 255, 0, 0, 255, 0, 0], { compression: 3, masks, headerSize: 56 });
    expect(decodeBmp(zero).data).toEqual(Uint8ClampedArray.from([...red, ...green]));
    const partial = bmp(2, 1, 32, [0, 0, 255, 0, 0, 255, 0, 64], { compression: 3, masks, headerSize: 56 });
    expect(decodeBmp(partial).data).toEqual(Uint8ClampedArray.of(255, 0, 0, 0, 0, 255, 0, 64));
  });

  test('falls back to the buffer length for a zero or oversized header file size', () => {
    for (const size of [0, 999]) {
      const bytes = bmp(1, 1, 24, [0, 0, 255, 0]);
      bytes.writeUInt32LE(size, 2);
      expect(isSupportedBmpHeader(bytes)).toBe(true);
      expect(decodeBmp(bytes).data).toEqual(Uint8ClampedArray.from(red));
      const truncated = bytes.subarray(0, bytes.length - 1);
      expect(() => decodeBmp(truncated)).toThrow(/truncated/);
      const badOffset = Buffer.from(bytes);
      badOffset.writeUInt32LE(bytes.length + 1, 10);
      expect(() => decodeBmp(badOffset)).toThrow(/BMP/);
    }
  });

  test('decodes RLE8 runs, absolute mode, deltas, and EOL', () => {
    const bytes = bmp(4, 3, 8, [4, 1, 0, 0, 0, 2, 1, 0, 3, 2, 0, 0, 0, 3, 3, 2, 1, 0, 1, 3, 0, 1],
      { compression: 1, palette });
    expect(decodeBmp(bytes).data).toEqual(Uint8ClampedArray.from([
      blue, green, red, blue, black, green, green, green, red, red, red, red,
    ].flat()));
  });

  test('decodes alternating RLE4 runs and odd-length padded absolute mode', () => {
    const bytes = bmp(5, 2, 4, [5, 0x12, 0, 0, 0, 5, 0x32, 0x10, 0x30, 0, 0, 1], { compression: 2, palette });
    expect(decodeBmp(bytes).data).toEqual(Uint8ClampedArray.from([
      blue, green, red, black, blue, red, green, red, green, red,
    ].flat()));
  });

  test('rejects malformed headers, truncated pixels, incompatible compression, and excessive dimensions', () => {
    const valid = bmp(1, 1, 24, [0, 0, 255, 0]);
    const headerChanges: [number, number][] = [[2, 20], [10, 20], [14, 41], [18, 0], [22, 0], [18, 16384], [30, 1]];
    for (const [offset, value] of headerChanges) {
      const invalid = Buffer.from(valid);
      invalid.writeUInt32LE(value, offset);
      expect(isSupportedBmpHeader(invalid)).toBe(false);
      expect(() => decodeBmp(invalid)).toThrow(/BMP/);
    }
    expect(() => decodeBmp(valid.subarray(0, valid.length - 1))).toThrow(/truncated/);
    expect(() => decodeBmp(bmp(16000, 16000, 8, [0, 1], { compression: 1, palette }))).toThrow(/budget/);
    expect(() => decodeBmp(bmp(1, -1, 8, [0, 1], { compression: 1, palette }))).toThrow(/Unsupported BMP/);
    expect(() => decodeBmp(bmp(1, 1, 16, [0, 0, 0, 0], { compression: 3, masks: [0xf800, 0xf800, 0x1f] }))).toThrow(/masks/);
    expect(() => decodeBmp(bmp(1, 1, 16, [0, 0, 0, 0], { compression: 3, masks: [0xa000, 0x7e0, 0x1f] }))).toThrow(/non-contiguous/);
  });

  test('rejects palette indices and RLE runs or deltas outside the bitmap', () => {
    expect(() => decodeBmp(bmp(1, 1, 8, [5, 0, 0, 0], { palette }))).toThrow(/palette index/);
    for (const pixels of [[3, 1, 0, 1], [0, 2, 2, 0, 0, 1], [1, 5, 0, 1], [1, 1], [0, 3, 1]]) {
      expect(() => decodeBmp(bmp(2, 1, 8, pixels, { compression: 1, palette }))).toThrow(/RLE|palette index/);
    }
  });
});
