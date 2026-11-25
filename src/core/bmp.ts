import type { RgbaImage } from './types.js';

const BI_RGB = 0, BI_RLE8 = 1, BI_RLE4 = 2, BI_BITFIELDS = 3, BI_ALPHABITFIELDS = 6;
const MAX_DIMENSION = 16_384;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;

export function hasBmpSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x42 && bytes[1] === 0x4d;
}

function invalid(reason: string): never {
  throw new Error(`Invalid BMP: ${reason}`);
}

function readHeader(bytes: Uint8Array) {
  if (!hasBmpSignature(bytes)) invalid('bad signature');
  if (bytes.length < 18) invalid('buffer too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileSize = view.getUint32(2, true);
  const offset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  if (![12, 40, 52, 56, 108, 124].includes(headerSize)) throw new Error('Unsupported BMP DIB header');
  const headerEnd = 14 + headerSize;
  if (fileSize > bytes.length || fileSize < headerEnd || offset < headerEnd || offset > fileSize) {
    invalid('truncated header or invalid pixel offset/file size');
  }
  const core = headerSize === 12;
  const width = core ? view.getUint16(18, true) : view.getInt32(18, true);
  const signedHeight = core ? view.getUint16(20, true) : view.getInt32(22, true);
  const height = Math.abs(signedHeight);
  const topDown = signedHeight < 0;
  const planes = view.getUint16(core ? 22 : 26, true);
  const depth = view.getUint16(core ? 24 : 28, true);
  const compression = core ? BI_RGB : view.getUint32(30, true);
  const imageSize = core ? 0 : view.getUint32(34, true);
  const colorsUsed = core ? 0 : view.getUint32(46, true);
  if (planes !== 1 || width <= 0 || height <= 0) invalid('invalid dimensions or planes');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height * 4 > MAX_DECODED_BYTES) {
    invalid('decoded byte budget or dimension limit exceeded');
  }
  const rle = compression === BI_RLE8 || compression === BI_RLE4;
  const bitfields = compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS;
  if (![1, 4, 8, 16, 24, 32].includes(depth) || (core && ![1, 4, 8, 24].includes(depth))
      || !(compression === BI_RGB || bitfields && [16, 32].includes(depth)
        || compression === BI_RLE8 && depth === 8 || compression === BI_RLE4 && depth === 4)
      || rle && topDown) throw new Error(`Unsupported BMP format: depth=${depth}, compression=${compression}, topDown=${topDown}`);

  let paletteStart = headerEnd;
  let masks = depth === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0xff0000, 0xff00, 0xff, 0];
  if (bitfields) {
    if (headerSize === 40) {
      const maskEnd = headerEnd + 12;
      if (offset < maskEnd) invalid('missing bitfield masks');
      // Some 40-byte headers store a fourth alpha mask immediately after RGB.
      const alpha = compression === BI_ALPHABITFIELDS || offset === maskEnd + 4 + colorsUsed * 4;
      paletteStart = maskEnd + (alpha ? 4 : 0);
      if (offset < paletteStart) invalid('missing alpha mask');
      masks = [0, 4, 8, ...(alpha ? [12] : [])].map(i => view.getUint32(headerEnd + i, true));
    } else {
      masks = [54, 58, 62, ...(headerSize >= 56 ? [66] : [])].map(i => view.getUint32(i, true));
    }
    if (compression === BI_ALPHABITFIELDS && !masks[3]) invalid('missing alpha mask');
  }
  let usedMask = 0;
  const components = masks.map((mask, i) => {
    if (!mask && i < 3) invalid('empty color mask');
    if (!mask) return null;
    if (depth >= 16 && (mask >= 2 ** depth || (mask & usedMask) !== 0)) invalid('overlapping or out-of-range masks');
    usedMask |= mask;
    const shift = 31 - Math.clz32(mask & -mask);
    const max = mask >>> shift;
    if ((max & (max + 1)) !== 0) invalid('non-contiguous bitfield mask');
    return { mask, shift, max };
  });

  const paletteCount = depth <= 8 ? colorsUsed || 2 ** depth : colorsUsed;
  const entrySize = core ? 3 : 4;
  if (depth <= 8 && paletteCount > 2 ** depth || paletteStart + paletteCount * entrySize > offset) {
    invalid('missing or invalid palette');
  }
  const stride = Math.ceil(width * depth / 32) * 4;
  const end = imageSize ? offset + imageSize : fileSize;
  if (end > fileSize || !rle && offset + stride * height > end) invalid('truncated pixel data');
  return { view, width, height, topDown, depth, rle, offset, end, stride, paletteStart, paletteCount, entrySize, components };
}

export function isSupportedBmpHeader(bytes: Uint8Array): boolean {
  try {
    readHeader(bytes);
    return true;
  } catch {
    return false;
  }
}

type BmpHeader = ReturnType<typeof readHeader>;

function walkRle(bytes: Uint8Array, header: BmpHeader, write?: (x: number, y: number, index: number) => void): void {
  const { width, height, depth, paletteCount, end } = header;
  let pos = header.offset, x = 0, y = 0;
  const read = () => {
    if (pos >= end) invalid('truncated RLE data');
    return bytes[pos++]!;
  };
  const emit = (index: number) => {
    if (x >= width || y >= height) invalid('RLE run exceeds image bounds');
    if (index >= paletteCount) invalid('palette index out of range');
    write?.(x, y, index);
    x++;
  };
  while (pos < end) {
    const count = read(), value = read();
    if (count) {
      for (let i = 0; i < count; i++) emit(depth === 8 ? value : i % 2 ? value & 15 : value >> 4);
    } else if (value === 1) {
      return;
    } else if (value === 0) {
      if (y >= height) invalid('RLE row exceeds image bounds');
      x = 0;
      y++;
    } else if (value === 2) {
      x += read();
      y += read();
      if (x >= width || y >= height) invalid('RLE delta exceeds image bounds');
    } else {
      const byteCount = depth === 8 ? value : Math.ceil(value / 2);
      for (let i = 0; i < byteCount; i++) {
        const literal = read();
        emit(depth === 8 ? literal : literal >> 4);
        if (depth === 4 && i * 2 + 1 < value) emit(literal & 15);
      }
      if (byteCount % 2) read();
    }
  }
  invalid('missing RLE end-of-bitmap marker');
}

function packedIndex(bytes: Uint8Array, row: number, depth: number, x: number): number {
  const bit = x * depth;
  return (bytes[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

export function decodeBmp(bytes: Uint8Array): RgbaImage {
  const header = readHeader(bytes);
  const { view, width, height, topDown, depth, rle, offset, stride, paletteCount, paletteStart, entrySize, components } = header;
  if (rle) walkRle(bytes, header);
  else if (depth <= 8) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (packedIndex(bytes, offset + y * stride, depth, x) >= paletteCount) invalid('palette index out of range');
      }
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const destination = (x: number, y: number) => ((topDown ? y : height - 1 - y) * width + x) * 4;
  const palettePixel = (x: number, y: number, index: number) => {
    const src = paletteStart + index * entrySize, dst = destination(x, y);
    data[dst] = bytes[src + 2]!;
    data[dst + 1] = bytes[src + 1]!;
    data[dst + 2] = bytes[src]!;
    data[dst + 3] = 255;
  };
  if (rle) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) palettePixel(x, y, 0);
    walkRle(bytes, header, palettePixel);
  } else {
    for (let y = 0; y < height; y++) {
      const row = offset + y * stride;
      for (let x = 0; x < width; x++) {
        if (depth <= 8) {
          palettePixel(x, y, packedIndex(bytes, row, depth, x));
          continue;
        }
        const src = row + x * (depth / 8), dst = destination(x, y);
        if (depth === 24) {
          data[dst] = bytes[src + 2]!;
          data[dst + 1] = bytes[src + 1]!;
          data[dst + 2] = bytes[src]!;
          data[dst + 3] = 255;
        } else {
          const value = depth === 16 ? view.getUint16(src, true) : view.getUint32(src, true);
          for (let i = 0; i < 4; i++) {
            const component = components[i];
            data[dst + i] = component ? Math.round(((value & component.mask) >>> component.shift) * 255 / component.max) : 255;
          }
        }
      }
    }
  }
  return { width, height, data };
}
