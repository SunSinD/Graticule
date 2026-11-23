import { hasPngSignature } from '../core/png.js';

export interface LoadedFile {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly url: string;
  /** The PNG carried EXIF data, so it came from a camera and is checked like a photo. */
  readonly hasExif: boolean;
}

export interface LoadOptions {
  readonly photo?: boolean;
}

export const MAX_PHOTO_SIDE = 1920;

let counter = 0;

const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp|heic|heif)$/i;

export function newId(): string {
  counter += 1;
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `h${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

export function isPhotoLike(file: File): boolean {
  return /jpe?g|heic|heif/i.test(file.type) || /\.(jpe?g|heic|heif)$/i.test(file.name);
}

function chunkType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

interface PngChunk {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/** Chunks up to IEND. Stops quietly at a chunk whose length runs past the end of the file. */
function pngChunks(bytes: Uint8Array): PngChunk[] {
  const out: PngChunk[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
    const type = chunkType(bytes, pos + 4);
    if (len > bytes.length - pos - 12) break;
    out.push({ type, start: pos, end: pos + 12 + len });
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  return out;
}

export function hasExifChunk(bytes: Uint8Array): boolean {
  return hasPngSignature(bytes) && pngChunks(bytes).some((c) => c.type === 'eXIf');
}

/**
 * Chromium ignores an eXIf chunk placed after the image data, so the photo would not be rotated.
 * Returns a copy with every such chunk moved just before the first IDAT, or null when none needs moving.
 */
export function moveExifBeforeIdat(bytes: Uint8Array): Uint8Array | null {
  if (!hasPngSignature(bytes)) return null;
  const chunks = pngChunks(bytes);
  const firstIdat = chunks.findIndex((c) => c.type === 'IDAT');
  if (firstIdat < 0) return null;
  const late = chunks.filter((c, i) => i > firstIdat && c.type === 'eXIf');
  if (late.length === 0) return null;
  const order = [...chunks.slice(0, firstIdat), ...late, ...chunks.slice(firstIdat).filter((c) => c.type !== 'eXIf')];
  const tail = chunks.length ? bytes.subarray(chunks[chunks.length - 1]!.end) : new Uint8Array(0);
  const out = new Uint8Array(bytes.length);
  out.set(bytes.subarray(0, 8), 0);
  let at = 8;
  for (const c of order) {
    out.set(bytes.subarray(c.start, c.end), at);
    at += c.end - c.start;
  }
  out.set(tail, at);
  return out;
}

/** True only for plain PNGs the core decoder reads exactly like the browser. Others go through the canvas. */
export function isRawPng(bytes: Uint8Array): boolean {
  if (!hasPngSignature(bytes) || bytes.length < 33 || chunkType(bytes, 12) !== 'IHDR') return false;
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  if (interlace !== 0) return false;
  if (colorType === 0 && bitDepth !== undefined && bitDepth < 8) return false;
  return !hasExifChunk(bytes);
}

async function decodeBitmap(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(file);
  }
}

async function toPngBytes(file: Blob): Promise<Uint8Array> {
  const bitmap = await decodeBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not convert image to PNG');
  return new Uint8Array(await blob.arrayBuffer());
}

export function makeUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
}

export async function loadFile(file: Blob, name: string, options: LoadOptions = {}): Promise<LoadedFile> {
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const hasExif = hasExifChunk(bytes);
  if (options.photo || !isRawPng(bytes)) {
    const fixed = hasExif ? moveExifBeforeIdat(bytes) : null;
    bytes = await toPngBytes(fixed ? new Blob([fixed as BlobPart], { type: 'image/png' }) : file);
  }
  return { id: newId(), name, bytes, url: makeUrl(bytes), hasExif };
}

export function releaseUrl(url: string): void {
  URL.revokeObjectURL(url);
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Collects every file under the entry. An entry the browser cannot read, such as a locked file or a
 * junction, is noted in `skipped` and the rest of the folder is still read.
 */
async function walk(entry: FileSystemEntry, out: File[], skipped: string[]): Promise<void> {
  try {
    if (entry.isFile) {
      out.push(await entryFile(entry as FileSystemFileEntry));
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await readEntries(reader);
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, out, skipped);
      }
    }
  } catch {
    skipped.push(entry.name || entry.fullPath || '?');
  }
}

/**
 * Files dropped on the page, folders included. Names of entries that could not be read go into `skipped`.
 * Non images are kept so the caller can filter them like the file picker and say when nothing was an image.
 */
export async function filesFromDataTransfer(dt: DataTransfer, skipped: string[] = []): Promise<File[]> {
  const out: File[] = [];
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  for (const e of entries) await walk(e, out, skipped);
  if (out.length === 0) out.push(...Array.from(dt.files));
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
