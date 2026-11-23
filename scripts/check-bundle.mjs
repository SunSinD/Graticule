import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const formatSource = readFileSync(resolve(root, 'src/core/export/format.ts'), 'utf8');
const versionMatch = /GRATICULE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(formatSource);

if (!versionMatch) throw new Error('Could not read GRATICULE_VERSION from src/core/export/format.ts');

const srcVersion = versionMatch[1];
const versions = {
  packageJson: packageJson.version,
  packageLock: packageLock.version,
  packageLockRoot: packageLock.packages?.['']?.version,
  source: srcVersion,
};

const mismatches = Object.entries(versions).filter(([, version]) => version !== '2.0.0');
if (mismatches.length > 0) {
  throw new Error(`Version mismatch: ${mismatches.map(([name, version]) => `${name}=${version ?? 'missing'}`).join(', ')} (expected 2.0.0)`);
}

if (versions.packageJson !== versions.packageLock || versions.packageLock !== versions.packageLockRoot || versions.packageLockRoot !== versions.source) {
  throw new Error(`Version fields disagree: ${JSON.stringify(versions)}`);
}

function collectAssets(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) return collectAssets(path);
    return /\.(?:m?js|css)$/i.test(name) ? [path] : [];
  }).sort((a, b) => a.localeCompare(b));
}

const assetsDir = resolve(root, 'dist/assets');
const assets = collectAssets(assetsDir);
if (assets.length === 0) throw new Error('No emitted JS or CSS assets found in dist/assets');

let gzippedBytes = 0;
for (const file of assets) {
  const bytes = readFileSync(file);
  const rawKiB = bytes.length / 1024;
  const gzipped = gzipSync(bytes).length;
  const gzipKiB = gzipped / 1024;
  gzippedBytes += gzipped;
  console.log(`${file.slice(root.length + 1)}  raw ${rawKiB.toFixed(2)} KiB  gzip ${gzipKiB.toFixed(2)} KiB`);
}
console.log(`Total gzipped JS+CSS: ${(gzippedBytes / 1024).toFixed(2)} KiB`);
if (gzippedBytes > 300 * 1024) {
  throw new Error(`Gzipped JS+CSS bundle exceeds 300 KiB (${gzippedBytes} bytes)`);
}

const swPath = resolve(root, 'dist/sw.js');
if (!existsSync(swPath)) throw new Error('dist/sw.js not found');
const swSource = readFileSync(swPath, 'utf8');
const precacheMatch = /PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/.exec(swSource);
if (!precacheMatch) throw new Error('Could not find PRECACHE_ASSETS in dist/sw.js');
const precacheAssets = new Set([...precacheMatch[1].matchAll(/['"]\.\/assets\/([^'"]+)['"]/g)].map((match) => match[1]));

for (const file of assets) {
  const relative = file.slice(resolve(root, 'dist').length + 1).replaceAll('\\', '/');
  const name = relative.replace(/^assets\//, '');
  if (!precacheAssets.has(name)) {
    throw new Error(`dist/sw.js does not precache emitted asset: ${relative}`);
  }
}

const portableRequested = process.argv.includes('--portable');
const portablePath = resolve(root, 'dist-portable/graticule-portable.html');
if (portableRequested || existsSync(portablePath)) {
  if (!existsSync(portablePath)) throw new Error('dist-portable/graticule-portable.html not found');
  const html = readFileSync(portablePath, 'utf8');
  if (/ <script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>/i.test(` ${html}`)) {
    throw new Error('Portable HTML contains an external script URL');
  }
  if (/<link[^>]+rel=["']stylesheet["'][^>]*>/i.test(html)) {
    throw new Error('Portable HTML contains an external stylesheet');
  }
  if (!/<link[^>]+rel=["']icon["'][^>]+href=["']data:image\/svg\+xml[^"']*["'][^>]*>/i.test(html)) {
    throw new Error('Portable HTML does not embed an SVG data-URI favicon');
  }
}
