import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function makePng(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const grid = x % Math.round(size / 4) === 0 || y % Math.round(size / 4) === 0;
      const minor = x % Math.round(size / 8) === 0 || y % Math.round(size / 8) === 0;
      const normX = x / (size - 1);
      const normY = 0.5 + 0.18 * Math.sin(normX * Math.PI * 2) - 0.06 * Math.sin(normX * Math.PI * 4);
      const waveDistance = Math.abs(y / (size - 1) - normY);
      const wave = waveDistance < (2.2 / size);

      let r = 10, g = 10, b = 10;
      if (minor) { r = 22; g = 22; b = 22; }
      if (grid) { r = 64; g = 64; b = 64; }
      if (wave) { r = 250; g = 250; b = 250; }
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function generatePwaIcons() {
  const publicDir = resolve(root, 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(resolve(publicDir, 'icon-192.png'), makePng(192));
  writeFileSync(resolve(publicDir, 'icon-512.png'), makePng(512));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generatePwaIcons();
}
