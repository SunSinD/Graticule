import { describe, expect, test } from 'vitest';
import { filesFromDataTransfer, hasExifChunk, isRawPng, moveExifBeforeIdat } from '../../src/ui/files.js';
import { decodePng } from '../../src/core/png.js';
import { sample } from '../core/fixtures.js';

const png = Uint8Array.from(sample('sine_schmitt.png'));

function chunk(type: string, data: Uint8Array, length = data.length): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function beforeIend(extra: Uint8Array): Uint8Array {
  const iend = png.length - 12;
  const out = new Uint8Array(png.length + extra.length);
  out.set(png.subarray(0, iend), 0);
  out.set(extra, iend);
  out.set(png.subarray(iend), iend + extra.length);
  return out;
}

describe('isRawPng', () => {
  test('reads a plain PNG directly', () => {
    expect(isRawPng(png)).toBe(true);
  });

  test('sends a PNG with an eXIf chunk after the image data through the canvas', () => {
    expect(isRawPng(beforeIend(chunk('eXIf', new Uint8Array([0x4d, 0x4d, 0, 42]))))).toBe(false);
  });

  test('stops safely on a chunk whose length runs past the end of the file', () => {
    expect(isRawPng(beforeIend(chunk('tEXt', new Uint8Array(4), 0x7fffffff)))).toBe(true);
  });
});

function chunkTypes(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(pos);
    out.push(String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)));
    pos += 12 + len;
  }
  return out;
}

function withCrc(c: Uint8Array): Uint8Array {
  let crc = 0xffffffff;
  for (const byte of c.subarray(4, c.length - 4)) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  new DataView(c.buffer, c.byteOffset).setUint32(c.length - 4, (crc ^ 0xffffffff) >>> 0);
  return c;
}

describe('moveExifBeforeIdat', () => {
  const exif = withCrc(chunk('eXIf', new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8])));

  test('moves a late eXIf chunk before the first IDAT and keeps every byte', () => {
    const late = beforeIend(exif);
    const fixed = moveExifBeforeIdat(late)!;
    expect(fixed).not.toBeNull();
    expect(fixed.length).toBe(late.length);
    const types = chunkTypes(fixed);
    expect(types[0]).toBe('IHDR');
    expect(types.indexOf('eXIf')).toBe(types.indexOf('IDAT') - 1);
    expect(types.filter((t) => t === 'eXIf')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('IEND');
    expect(chunkTypes(late).filter((t) => t !== 'eXIf')).toEqual(types.filter((t) => t !== 'eXIf'));
    expect(Buffer.from(fixed.subarray(0, 33)).equals(Buffer.from(late.subarray(0, 33)))).toBe(true);
    const before = decodePng(png);
    const after = decodePng(fixed);
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(true);
  });

  test('leaves a PNG alone when eXIf is already before the image data or missing', () => {
    expect(moveExifBeforeIdat(png)).toBeNull();
    const early = moveExifBeforeIdat(beforeIend(exif))!;
    expect(moveExifBeforeIdat(early)).toBeNull();
    expect(moveExifBeforeIdat(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test('hasExifChunk finds eXIf anywhere in a PNG', () => {
    expect(hasExifChunk(png)).toBe(false);
    expect(hasExifChunk(beforeIend(exif))).toBe(true);
  });
});

interface FakeEntry {
  readonly name: string;
  readonly fullPath: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  file?: (ok: (f: File) => void, fail: (e: Error) => void) => void;
  createReader?: () => { readEntries: (ok: (list: FakeEntry[]) => void, fail: (e: Error) => void) => void };
}

function fileEntry(name: string, broken = false): FakeEntry {
  return {
    name,
    fullPath: `/${name}`,
    isFile: true,
    isDirectory: false,
    file: (ok, fail) => (broken ? fail(new Error('NotReadableError')) : ok(new File([new Uint8Array(4)], name, { type: name.endsWith('.png') ? 'image/png' : 'text/plain' }))),
  };
}

function dirEntry(name: string, children: readonly FakeEntry[], broken = false): FakeEntry {
  return {
    name,
    fullPath: `/${name}`,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let done = false;
      return {
        readEntries: (ok, fail) => {
          if (broken) return fail(new Error('NotFoundError'));
          const out = done ? [] : [...children];
          done = true;
          ok(out);
        },
      };
    },
  };
}

function dropOf(entries: readonly FakeEntry[]): DataTransfer {
  return {
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null })),
    files: [],
  } as unknown as DataTransfer;
}

describe('filesFromDataTransfer', () => {
  test('a dropped folder with an unreadable file or junction still loads every other image', async () => {
    const folder = dirEntry('lab', [
      fileEntry('b.png'),
      fileEntry('locked.png', true),
      dirEntry('junction', [], true),
      dirEntry('sub', [fileEntry('a.png'), fileEntry('notes.txt')]),
      fileEntry('c10.png'),
      fileEntry('c2.png'),
    ]);
    const skipped: string[] = [];
    const files = await filesFromDataTransfer(dropOf([folder]), skipped);
    expect(files.map((f) => f.name)).toEqual(['a.png', 'b.png', 'c2.png', 'c10.png']);
    expect(skipped).toEqual(['locked.png', 'junction']);
  });

  test('works without a skipped list', async () => {
    const files = await filesFromDataTransfer(dropOf([fileEntry('x.png', true), fileEntry('y.png')]));
    expect(files.map((f) => f.name)).toEqual(['y.png']);
  });
});
