import { unzlibSync } from 'fflate';
import type { RgbaImage } from './types.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure TypeScript PNG decoder using fflate.
 * Produces bit-for-bit identical RGBA buffers in browser, Web Worker, and Node CLI.
 * Supports 8-bit grayscale, RGB, RGBA, grayscale+alpha, and 1/2/4/8-bit palette PNGs.
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
    const chunk = bytes.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
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
      break;
    }

    pos = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error('Invalid PNG: missing or zero IHDR dimensions');
  }
  if (interlace !== 0) {
    throw new Error('Unsupported PNG: Adam7 interlaced PNGs are not supported in core decoder');
  }

  const compressed = new Uint8Array(totalIdatLen);
  let offset = 0;
  for (const part of idatChunks) {
    compressed.set(part, offset);
    offset += part.length;
  }

  const inflated = unzlibSync(compressed);

  let channels = 1;
  if (colorType === 0) channels = 1;
  else if (colorType === 2) channels = 3;
  else if (colorType === 3) channels = 1;
  else if (colorType === 4) channels = 2;
  else if (colorType === 6) channels = 4;
  else throw new Error(`Unsupported PNG colorType: ${colorType}`);

  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((width * bitsPerPixel) / 8);

  if (inflated.length < height * (stride + 1)) {
    throw new Error('Invalid PNG: decompressed data shorter than expected');
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const curr = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart] ?? 0;

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

    if (colorType === 6 && bitDepth === 8) {
      out.set(curr, y * width * 4);
    } else if (colorType === 2 && bitDepth === 8) {
      const base = y * width * 4;
      for (let x = 0; x < width; x++) {
        const si = x * 3;
        const di = base + x * 4;
        out[di] = curr[si] ?? 0;
        out[di + 1] = curr[si + 1] ?? 0;
        out[di + 2] = curr[si + 2] ?? 0;
        out[di + 3] = 255;
      }
    } else if (colorType === 0 && bitDepth === 8) {
      const base = y * width * 4;
      for (let x = 0; x < width; x++) {
        const g = curr[x] ?? 0;
        const di = base + x * 4;
        out[di] = g;
        out[di + 1] = g;
        out[di + 2] = g;
        out[di + 3] = 255;
      }
    } else if (colorType === 4 && bitDepth === 8) {
      const base = y * width * 4;
      for (let x = 0; x < width; x++) {
        const g = curr[x * 2] ?? 0;
        const a = curr[x * 2 + 1] ?? 255;
        const di = base + x * 4;
        out[di] = g;
        out[di + 1] = g;
        out[di + 2] = g;
        out[di + 3] = a;
      }
    } else if (colorType === 3 && palette) {
      const base = y * width * 4;
      const mask = (1 << bitDepth) - 1;
      for (let x = 0; x < width; x++) {
        const bitPos = x * bitDepth;
        const byteIdx = bitPos >> 3;
        const shift = 8 - bitDepth - (bitPos & 7);
        const idx = ((curr[byteIdx] ?? 0) >> shift) & mask;
        const pi = idx * 3;
        const di = base + x * 4;
        out[di] = palette[pi] ?? 0;
        out[di + 1] = palette[pi + 1] ?? 0;
        out[di + 2] = palette[pi + 2] ?? 0;
        out[di + 3] = trns && idx < trns.length ? (trns[idx] ?? 255) : 255;
      }
    } else if (bitDepth === 16) {
      const base = y * width * 4;
      for (let x = 0; x < width; x++) {
        const di = base + x * 4;
        if (colorType === 2) {
          out[di] = curr[x * 6] ?? 0;
          out[di + 1] = curr[x * 6 + 2] ?? 0;
          out[di + 2] = curr[x * 6 + 4] ?? 0;
          out[di + 3] = 255;
        } else if (colorType === 6) {
          out[di] = curr[x * 8] ?? 0;
          out[di + 1] = curr[x * 8 + 2] ?? 0;
          out[di + 2] = curr[x * 8 + 4] ?? 0;
          out[di + 3] = curr[x * 8 + 6] ?? 255;
        } else {
          const g = curr[x * 2] ?? 0;
          out[di] = g;
          out[di + 1] = g;
          out[di + 2] = g;
          out[di + 3] = 255;
        }
      }
    } else {
      throw new Error(`Unsupported PNG format: colorType=${colorType} bitDepth=${bitDepth}`);
    }

    prev.set(curr);
  }

  return { width, height, data: out };
}
