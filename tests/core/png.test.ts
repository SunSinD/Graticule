import { zlibSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { decodePng } from '../../src/core/png.js';

interface PngSpec {
  readonly depth: number;
  readonly color: number;
  readonly scanlines: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly interlace?: number;
  readonly transparency?: readonly number[];
  readonly palette?: readonly number[];
  readonly chunkOrder?: readonly ('PLTE' | 'tRNS' | 'IDAT')[];
  readonly corruptAdler?: boolean;
  readonly padding?: readonly number[];
  readonly level?: 0 | 6;
}

function png({ depth, color, scanlines, width = 2, height = 1, interlace = 0, transparency, palette, corruptAdler,
  padding = [], level = 6, chunkOrder = ['PLTE', 'tRNS', 'IDAT'] }: PngSpec): Uint8Array {
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
  header[12] = interlace;
  const compressed = zlibSync(Uint8Array.from(scanlines), { level });
  if (corruptAdler) compressed[compressed.length - 1] = compressed[compressed.length - 1]! ^ 1;
  const parts = {
    PLTE: palette ? [chunk('PLTE', Uint8Array.from(palette))] : [],
    tRNS: transparency ? [chunk('tRNS', Uint8Array.from(transparency))] : [],
    IDAT: [chunk('IDAT', compressed.subarray(0, -2)), chunk('IDAT', Uint8Array.of(...compressed.subarray(-2), ...padding))],
  };
  const chunks = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', header),
    ...chunkOrder.flatMap(type => parts[type]),
    chunk('IEND', new Uint8Array()),
  ];
  const bytes = new Uint8Array(chunks.reduce((len, part) => len + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

const passAt = [
  [1, 6, 4, 6, 2, 6, 4, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
  [5, 6, 5, 6, 5, 6, 5, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
  [3, 6, 4, 6, 3, 6, 4, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
  [5, 6, 5, 6, 5, 6, 5, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
];

function adam7(width: number, height: number, color: number, depth: number) {
  const channelCount = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]!;
  const max = 2 ** depth - 1;
  const bpp = Math.ceil(channelCount * depth / 8);
  const pixels = Array.from({ length: width * height }, (_, index) =>
    Array.from({ length: channelCount }, (_, channel) => (index * 4949 + channel * 10723) & max));
  const scanlines: number[] = [];
  for (let pass = 1; pass <= 7; pass++) {
    let previous: number[] = [];
    for (let y = 0; y < height; y++) {
      const samples = pixels.slice(y * width, (y + 1) * width).flatMap((pixel, x) =>
        passAt[y % 8]![x % 8] === pass ? pixel : []);
      if (!samples.length) continue;
      const bytes = Array<number>(Math.ceil(samples.length * depth / 8)).fill(0);
      for (const [i, value] of samples.entries()) {
        const bit = i * depth;
        bytes[bit >> 3] = bytes[bit >> 3]! | (depth === 16 ? value >> 8 : value << (8 - depth - bit % 8));
        if (depth === 16) bytes[(bit >> 3) + 1] = value & 255;
      }
      const filter = (pass + y) % 5;
      scanlines.push(filter, ...bytes.map((value, i) => {
        const left = bytes[i - bpp] ?? 0;
        const up = previous[i] ?? 0;
        const diagonal = previous[i - bpp] ?? 0;
        const predictor = left + up - diagonal;
        const paeth = [left, up, diagonal].sort((a, b) => Math.abs(a - predictor) - Math.abs(b - predictor))[0]!;
        return (value - [0, left, up, Math.floor((left + up) / 2), paeth][filter]!) & 255;
      }));
      previous = bytes;
    }
  }
  const palette = color === 3 ? Array.from({ length: (max + 1) * 3 }, (_, i) => i * 19 % 256) : undefined;
  const transparency = color === 3 ? [31] : color === 0 ? [0, 0] : color === 2
    ? pixels[0]!.flatMap(value => [value >> 8, value & 255]) : undefined;
  const byte = (value: number) => depth > 8 ? value >> 8 : value * 255 / max;
  const expected = pixels.flatMap(([r, g, b, a], index) => {
    if (color === 3) return [...palette!.slice(r! * 3, r! * 3 + 3), r === 0 ? 31 : 255];
    if (color === 2 || color === 6) return [byte(r!), byte(g!), byte(b!), color === 6 ? byte(a!) : index === 0 ? 0 : 255];
    return [byte(r!), byte(r!), byte(r!), color === 4 ? byte(g!) : r === 0 ? 0 : 255];
  });
  return { bytes: png({ width, height, color, depth, scanlines, interlace: 1, palette, transparency }), expected };
}

describe('PNG decode', () => {
  test.each([
    ['duplicate PLTE', ['PLTE', 'PLTE', 'tRNS', 'IDAT'], /PLTE/],
    ['PLTE after IDAT', ['IDAT', 'PLTE'], /PLTE/],
    ['tRNS before indexed PLTE', ['tRNS', 'PLTE', 'IDAT'], /tRNS/],
    ['tRNS after IDAT', ['PLTE', 'IDAT', 'tRNS'], /tRNS/],
  ] as const)('rejects %s even with valid chunk checksums', (_, chunkOrder, error) => {
    const bytes = png({ depth: 8, color: 3, scanlines: [0, 0, 0], palette: [1, 2, 3], transparency: [128], chunkOrder });
    expect(() => decodePng(bytes)).toThrow(error);
  });

  test('checks the zlib Adler-32 trailer across IDAT chunks with valid PNG CRCs', () => {
    const spec = { depth: 8, color: 0, scanlines: [0, 12, 19] };
    expect([...decodePng(png(spec)).data]).toEqual([12, 12, 12, 255, 19, 19, 19, 255]);
    expect(() => decodePng(png({ ...spec, corruptAdler: true }))).toThrow(/zlib Adler-32 checksum mismatch/);
  });

  test.each([0, 6] as const)('ignores padding after the real Adler-32 trailer at compression level %i', level => {
    const width = 1500;
    const scanlines = [0, ...Array.from({ length: width }, (_, i) => Math.floor(256 * Math.abs(Math.sin(i * 782.322))))];
    const spec = { depth: 8, color: 0, width, scanlines, level };
    const adler = zlibSync(Uint8Array.from(scanlines)).subarray(-4);
    const expected = scanlines.slice(1).flatMap(value => [value, value, value, 255]);
    expect([...decodePng(png({ ...spec, padding: [1, 255, 8, 23, 97] })).data]).toEqual(expected);
    expect(() => decodePng(png({ ...spec, corruptAdler: true, padding: [8, 23, ...adler] })))
      .toThrow(/zlib Adler-32 checksum mismatch/);
  });

  test.each([
    [0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8],
    [4, 8], [4, 16], [6, 8], [6, 16],
  ])('decodes all Adam7 passes for color type %i at %i bits', (color, depth) => {
    const { bytes, expected } = adam7(13, 11, color, depth);
    expect([...decodePng(bytes).data]).toEqual(expected);
  });

  test.each([[1, 1], [2, 2], [3, 5], [7, 7]])('skips empty Adam7 passes in a %i by %i image', (width, height) => {
    for (const [color, depth] of [[6, 8], [0, 2]] as const) {
      const { bytes, expected } = adam7(width, height, color, depth);
      expect(decodePng(bytes)).toEqual({ width, height, data: Uint8ClampedArray.from(expected) });
    }
  });
  test.each(['IHDR', 'PLTE', 'IDAT', 'IEND'])('rejects a bad CRC on a structurally valid %s chunk', chunk => {
    const bytes = png({ depth: 1, color: 3, scanlines: [0, 0b01000000], palette: [10, 20, 30, 40, 50, 60] });
    const view = new DataView(bytes.buffer);
    for (let pos = 8; pos < bytes.length;) {
      const end = pos + 8 + view.getUint32(pos);
      if (String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)) === chunk) bytes[end] = bytes[end]! ^ 1;
      pos = end + 4;
    }
    expect(() => decodePng(bytes)).toThrow(`CRC mismatch in ${chunk} chunk`);
  });
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
