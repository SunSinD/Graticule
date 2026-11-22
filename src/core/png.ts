import { Inflate } from 'fflate';
import type { RgbaImage } from './types.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
};
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]!) & 255]!;
  return (~crc) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  const modulus = 65521;
  let a = 1;
  let b = 0;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i = start; i < end; i++) {
      a += bytes[i]!;
      b += a;
    }
    a %= modulus;
    b %= modulus;
  }
  return ((b << 16) | a) >>> 0;
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] ?? 0) << 24) |
      ((buf[offset + 1] ?? 0) << 16) |
      ((buf[offset + 2] ?? 0) << 8) |
      (buf[offset + 3] ?? 0)) >>>
    0
  );
}

function readU16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset]! << 8) | buf[offset + 1]!;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function inflateScanlines(compressed: Uint8Array, scanlineBytes: number): Uint8Array {
  const cmf = compressed[0]!;
  const flg = compressed[1]!;
  if (compressed.length < 8 || (cmf & 15) !== 8 || (cmf >> 4) > 7 || (flg & 32) || ((cmf << 8) | flg) % 31 !== 0) {
    throw new Error('Invalid PNG: invalid zlib header');
  }
  const inflated = new Uint8Array(scanlineBytes);
  let written = 0;
  const stream = new Inflate(chunk => {
    if (chunk.length > inflated.length - written) throw new Error('Decompressed scanline byte length mismatch');
    inflated.set(chunk, written);
    written += chunk.length;
  });
  // fflate's raw stream retains unread input and the current bit offset. Its public
  // API does not report the DEFLATE end, which precedes Adler-32 and any padding.
  const position = stream as unknown as { p: Uint8Array; s: { p: number; f?: number; l?: Uint16Array } };
  let trailer = -1;
  try {
    const limit = compressed.length - 4;
    for (let offset = 2; offset < limit;) {
      // Bound temporary decompression allocations before checking the declared output size.
      const end = Math.min(offset + 1024, limit);
      stream.push(compressed.subarray(offset, end), end === limit);
      if (position.s.f && !position.s.l) {
        trailer = end - position.p.length + Math.ceil(position.s.p / 8);
        break;
      }
      offset = end;
    }
  } catch (error) {
    throw new Error('Invalid PNG: unable to decompress scanlines', { cause: error });
  }
  if (trailer < 0 || written !== scanlineBytes) throw new Error('Invalid PNG: decompressed scanline byte length mismatch');
  if (adler32(inflated) !== readU32BE(compressed, trailer)) {
    throw new Error('Invalid PNG: zlib Adler-32 checksum mismatch');
  }
  return inflated;
}

/**
 * Pure TypeScript PNG decoder using fflate.
 * Produces bit-for-bit identical RGBA buffers in browser, Web Worker, and Node CLI.
 * Supports all PNG color types and bit depths, including Adam7 interlacing.
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 33) {
    throw new Error('Invalid PNG: buffer too short');
  }
  if (!hasPngSignature(bytes)) throw new Error('Invalid PNG: bad signature');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  let ended = false;
  const idatChunks: Uint8Array[] = [];
  let totalIdatLen = 0;

  while (pos + 12 <= bytes.length) {
    const length = readU32BE(bytes, pos);
    const type = String.fromCharCode(
      bytes[pos + 4] ?? 0,
      bytes[pos + 5] ?? 0,
      bytes[pos + 6] ?? 0,
      bytes[pos + 7] ?? 0
    );
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`Invalid PNG: truncated ${type} chunk`);
    }
    if (crc32(bytes, pos + 4, dataEnd) !== readU32BE(bytes, dataEnd)) {
      throw new Error(`Invalid PNG: CRC mismatch in ${type} chunk`);
    }
    const chunk = bytes.subarray(dataStart, dataEnd);

    if ((pos === 8) !== (type === 'IHDR')) throw new Error('Invalid PNG: expected exactly one initial IHDR');
    if (type === 'IHDR') {
      if (length !== 13 || chunk[10] !== 0 || chunk[11] !== 0) throw new Error('Invalid PNG: invalid IHDR');
      width = readU32BE(chunk, 0);
      height = readU32BE(chunk, 4);
      bitDepth = chunk[8] ?? 0;
      colorType = chunk[9] ?? 0;
      interlace = chunk[12] ?? 0;
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      trns = chunk;
    } else if (type === 'IDAT') {
      idatChunks.push(chunk);
      totalIdatLen += chunk.length;
    } else if (type === 'IEND') {
      ended = length === 0;
      break;
    }

    pos = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error('Invalid PNG: missing or zero IHDR dimensions');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error('Invalid PNG: dimensions too large');
  if (interlace > 1) throw new Error('Invalid PNG: unknown interlace method');
  if (!ended || !totalIdatLen) throw new Error('Invalid PNG: missing IDAT or IEND');
  if (!DEPTHS[colorType]?.includes(bitDepth)) {
    throw new Error(`Unsupported PNG format: colorType=${colorType} bitDepth=${bitDepth}`);
  }
  if (colorType === 3 && (!palette || palette.length < 3 || palette.length % 3 !== 0 || palette.length > 3 * (1 << bitDepth))) {
    throw new Error('Invalid PNG: missing or invalid palette');
  }
  if (trns && !(colorType === 0 && trns.length === 2 || colorType === 2 && trns.length === 6
      || colorType === 3 && palette && trns.length <= palette.length / 3)) {
    throw new Error('Invalid PNG: invalid tRNS data');
  }

  const channels = CHANNELS[colorType]!;
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const passes = (interlace === 1 ? ADAM7 : [[0, 0, 1, 1]] as const).map(([x, y, dx, dy]) => {
    const columns = Math.ceil((width - x) / dx);
    const rows = Math.ceil((height - y) / dy);
    return { x, y, dx, dy, columns, rows, stride: Math.ceil(columns * bitsPerPixel / 8) };
  }).filter(pass => pass.columns > 0 && pass.rows > 0);
  const scanlineBytes = passes.reduce((total, pass) => total + pass.rows * (pass.stride + 1), 0);
  const rgbaBytes = width * height * 4;
  if (rgbaBytes + scanlineBytes > MAX_DECODED_BYTES) throw new Error('Invalid PNG: decoded byte budget exceeded');

  const compressed = new Uint8Array(totalIdatLen);
  let offset = 0;
  for (const part of idatChunks) {
    compressed.set(part, offset);
    offset += part.length;
  }

  const inflated = inflateScanlines(compressed, scanlineBytes);
  const out = new Uint8ClampedArray(rgbaBytes);
  const transparentR = trns && colorType !== 3 ? readU16BE(trns, 0) : -1;
  const transparentG = trns && colorType === 2 ? readU16BE(trns, 2) : -1;
  const transparentB = trns && colorType === 2 ? readU16BE(trns, 4) : -1;
  const packedMask = (1 << bitDepth) - 1;
  const rgba8 = (value: number) => bitDepth === 16 ? value >> 8 : value;

  let rowStart = 0;
  for (const { x: x0, y: y0, dx, dy, columns, rows, stride } of passes) {
    let prev = new Uint8Array(stride);
    let curr = new Uint8Array(stride);
    const sample = (i: number) => bitDepth === 16 ? readU16BE(curr, i * 2) : curr[i]!;
    for (let row = 0; row < rows; row++) {
      const y = y0 + row * dy;
      const filter = inflated[rowStart]!;
      if (filter > 4) throw new Error(`Invalid PNG: unknown scanline filter ${filter}`);

      for (let i = 0; i < stride; i++) {
        const rawByte = inflated[rowStart + 1 + i] ?? 0;
        const a = i >= bpp ? (curr[i - bpp] ?? 0) : 0;
        const b = prev[i] ?? 0;
        const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
        let val = rawByte;
        if (filter === 1) val = (rawByte + a) & 0xff;
        else if (filter === 2) val = (rawByte + b) & 0xff;
        else if (filter === 3) val = (rawByte + ((a + b) >> 1)) & 0xff;
        else if (filter === 4) val = (rawByte + paethPredictor(a, b, c)) & 0xff;
        curr[i] = val;
      }

      if (colorType === 6 && bitDepth === 8 && dx === 1) {
        out.set(curr, y * width * 4);
      } else {
        for (let x = 0; x < columns; x++) {
          const di = (y * width + x0 + x * dx) * 4;
          const si = x * channels;
          const bit = x * bitDepth;
          const value = bitDepth < 8 ? (curr[bit >> 3]! >> (8 - bitDepth - (bit & 7))) & packedMask : sample(si);
          if (colorType === 3) {
            const pi = value * 3;
            if (pi >= palette!.length) throw new Error('Invalid PNG: palette index out of range');
            out[di] = palette![pi]!;
            out[di + 1] = palette![pi + 1]!;
            out[di + 2] = palette![pi + 2]!;
            out[di + 3] = trns?.[value] ?? 255;
          } else if (colorType === 2 || colorType === 6) {
            const g = sample(si + 1);
            const b = sample(si + 2);
            out[di] = rgba8(value);
            out[di + 1] = rgba8(g);
            out[di + 2] = rgba8(b);
            out[di + 3] = colorType === 6 ? rgba8(sample(si + 3))
              : value === transparentR && g === transparentG && b === transparentB ? 0 : 255;
          } else {
            const g = bitDepth < 8 ? value * 255 / packedMask : rgba8(value);
            out[di] = g;
            out[di + 1] = g;
            out[di + 2] = g;
            out[di + 3] = colorType === 4 ? rgba8(sample(si + 1)) : value === transparentR ? 0 : 255;
          }
        }
      }
      [prev, curr] = [curr, prev];
      rowStart += stride + 1;
    }
  }

  return { width, height, data: out };
}
