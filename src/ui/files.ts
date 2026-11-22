import { hasPngSignature } from '../core/png.js';

export interface LoadedFile {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly url: string;
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

export function isRawPng(bytes: Uint8Array): boolean {
  return hasPngSignature(bytes) && bytes.length >= 29 && bytes[28] === 0;
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
  if (options.photo || !isRawPng(bytes)) bytes = await toPngBytes(file);
  return { id: newId(), name, bytes, url: makeUrl(bytes) };
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

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await entryFile(entry as FileSystemFileEntry));
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await readEntries(reader);
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
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
  for (const e of entries) await walk(e, out);
  if (out.length === 0) out.push(...Array.from(dt.files));
  return out.filter(isImageFile).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
