import { hasPngSignature } from '../core/png.js';

export interface LoadedFile {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly url: string;
}

let counter = 0;

const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp)$/i;

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

async function toPngBytes(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not convert image to PNG');
  return new Uint8Array(await blob.arrayBuffer());
}

export async function loadFile(file: Blob, name: string): Promise<LoadedFile> {
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const nonInterlacedPng = hasPngSignature(bytes) && bytes.length >= 29 && bytes[28] === 0;
  if (!nonInterlacedPng) bytes = await toPngBytes(file);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
  counter += 1;
  return { id: `f${counter}`, name, bytes, url };
}

export function releaseFiles(files: readonly LoadedFile[]): void {
  for (const f of files) URL.revokeObjectURL(f.url);
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

export async function fetchSample(name: string): Promise<LoadedFile> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
  if (!res.ok) throw new Error(`Sample ${name} not found`);
  return loadFile(await res.blob(), name);
}
