import { zlibSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { decodePng } from '../../src/core/png.js';

interface PngSpec {
  readonly depth: number;
  readonly color: number;
  readonly scanlines: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly transparency?: readonly number[];
  readonly palette?: readonly number[];
}

function png({ depth, color, scanlines, width = 2, height = 1, transparency, palette }: PngSpec): Uint8Array {
  function chunk(type: string, data: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(data.length + 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(data, 8);
    let crc = -1;
    for (const byte of bytes.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    view.setUint32(bytes.length - 4, ~crc);
    return bytes;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([depth, color], 8);
  const chunks = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', Uint8Array.from(palette))] : []),
    ...(transparency ? [chunk('tRNS', Uint8Array.from(transparency))] : []),
    chunk('IDAT', zlibSync(Uint8Array.from(scanlines))), chunk('IEND', new Uint8Array()),
  ];
  const bytes = new Uint8Array(chunks.reduce((len, part) => len + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

describe('PNG decode', () => {
  test.each([
    [1, 0b01000000, [0, 255, 0]],
    [2, 0b01101100, [85, 170, 255]],
    [4, 0x36, [51, 102]],
  ] as const)('unpacks %i-bit grayscale and scales levels to 8 bits', (depth, packed, levels) => {
    const result = decodePng(png({ depth, color: 0, scanlines: [0, packed], width: levels.length }));
    expect([...result.data]).toEqual(levels.flatMap(value => [value, value, value, 255]));
  });

  test('keeps separate gray and alpha samples for 16-bit filtered pixels', () => {
    const scanlines = [1, 0x12, 0xab, 0x34, 0xcd, 0x44 - 0x12, 0, 0x89 - 0x34, 0];
    expect([...decodePng(png({ depth: 16, color: 4, scanlines })).data])
      .toEqual([0x12, 0x12, 0x12, 0x34, 0x44, 0x44, 0x44, 0x89]);
  });

  test('applies grayscale, indexed and RGB transparency at the original bit depth', () => {
    expect([...decodePng(png({ depth: 2, color: 0, scanlines: [0, 0b01100000], transparency: [0, 1] })).data])
      .toEqual([85, 85, 85, 0, 170, 170, 170, 255]);
    expect([...decodePng(png({ depth: 1, color: 3, scanlines: [0, 0b01000000],
      palette: [10, 20, 30, 40, 50, 60], transparency: [80] })).data])
      .toEqual([10, 20, 30, 80, 40, 50, 60, 255]);
    expect([...decodePng(png({ depth: 8, color: 2, scanlines: [0, 10, 20, 30, 10, 20, 31],
      transparency: [0, 10, 0, 20, 0, 30] })).data])
      .toEqual([10, 20, 30, 0, 10, 20, 31, 255]);
    const color16 = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc];
    expect([...decodePng(png({ depth: 16, color: 2, scanlines: [0, ...color16, ...color16.slice(0, -1), 0xba],
      transparency: color16 })).data]).toEqual([0x12, 0x56, 0x9a, 0, 0x12, 0x56, 0x9a, 255]);
  });

  test('rejects invalid formats and dimensions before inflating', () => {
    expect(() => decodePng(png({ depth: 4, color: 2, scanlines: [] }))).toThrow(/colorType=2 bitDepth=4/);
    expect(() => decodePng(png({ depth: 8, color: 1, scanlines: [] }))).toThrow(/Unsupported PNG format/);
    expect(() => decodePng(png({ depth: 16, color: 6, width: 8192, height: 8192, scanlines: [] }))).toThrow(/byte budget/);
    expect(() => decodePng(png({ depth: 8, color: 6, width: 0, scanlines: [] }))).toThrow(/zero IHDR/);
    expect(() => decodePng(png({ depth: 8, color: 6, width: 0xffffffff, scanlines: [] }))).toThrow(/dimensions too large/);
  });

  test.each([[0], [0, 12, 19, 7], Array<number>(10_000).fill(0)])(
    'requires exactly the declared bytes in each set of rows', (...scanlines) => {
      expect(() => decodePng(png({ depth: 8, color: 0, scanlines }))).toThrow(/scanline/);
    },
  );

  test('rejects invalid filters, palette indexes and missing structural chunks', () => {
    expect(() => decodePng(png({ depth: 8, color: 0, scanlines: [5, 12, 19] }))).toThrow(/scanline filter/);
    expect(() => decodePng(png({ depth: 2, color: 3, scanlines: [0, 0b10000000], palette: [0, 0, 0] }))).toThrow(/palette index/);
    expect(() => decodePng(png({ depth: 8, color: 3, scanlines: [0, 0, 0] }))).toThrow(/missing or invalid palette/);
    const bytes = png({ depth: 8, color: 0, scanlines: [0, 12, 19] });
    expect(() => decodePng(bytes.subarray(0, -12))).toThrow(/IEND/);
  });
});
