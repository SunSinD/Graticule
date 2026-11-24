import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = resolve(root, 'dist-portable', 'tmp');
const outputDir = resolve(root, 'dist-portable');
const outputFile = resolve(outputDir, 'graticule-portable.html');

rmSync(tmpDir, { recursive: true, force: true });
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GRATICULE_PORTABLE: '1', VITE_BASE_PATH: './' },
});

const indexPath = resolve(tmpDir, 'index.html');
if (!existsSync(indexPath)) {
  throw new Error('Portable build failed: tmp/index.html not found.');
}

let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta[^>]+name=["']theme-color["'][^>]*>/gi, '<meta name="theme-color" content="#0a0a0a" />');
html = html.replace(/<link[^>]+rel=["']manifest["'][^>]*>/gi, '');
html = html.replace(/<link[^>]+rel=["'](?:modulepreload|preload|apple-touch-icon)["'][^>]*>/gi, '');
const faviconSvg = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8');
const faviconDataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(faviconSvg).replaceAll('\'', '%27')}`;
html = html.replace(/<link[^>]+rel=["']icon["'][^>]*>/gi, () =>
  `<link rel="icon" type="image/svg+xml" href="${faviconDataUri}" />`);

for (const match of [...html.matchAll(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi)]) {
  const href = match[1];
  const file = resolve(tmpDir, href.replace(/^\.\//, '').replace(/^\//, ''));
  if (!existsSync(file)) throw new Error(`Missing portable stylesheet: ${href}`);
  const css = readFileSync(file, 'utf8').replace(/<\/style/gi, '<\\/style');
  html = html.replace(match[0], () => `<style>${css}</style>`);
}

const scripts = [...html.matchAll(/<script([^>]*)src=["']([^"']+)["']([^>]*)><\/script>/gi)];
const inlineScripts = [];
for (const match of scripts) {
  const src = match[2];
  const file = resolve(tmpDir, src.replace(/^\.\//, '').replace(/^\//, ''));
  if (!existsSync(file)) throw new Error(`Missing portable script: ${src}`);
  const code = readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script');
  inlineScripts.push(code);
  html = html.replace(match[0], () => '');
}

if (!inlineScripts.length || !/<\/body>/i.test(html)) throw new Error('Portable build could not inline the app scripts.');
const portableBootstrap = '<script>globalThis.__GRATICULE_PORTABLE__ = true; globalThis.Worker = undefined;</script>';
html = html.replace(/<\/body>/i, () => `${portableBootstrap}<script type="module">${inlineScripts.join('\n')}</script></body>`);

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputFile, html);
rmSync(tmpDir, { recursive: true, force: true });
if (Buffer.byteLength(html) === 0) throw new Error('Portable build produced an empty HTML file.');
if (/<script[^>]+src=["'][^"']+["'][^>]*>/i.test(html)) {
  throw new Error('Portable build contains an external script reference.');
}
if (/<link[^>]+rel=["']stylesheet["'][^>]*>/i.test(html)) {
  throw new Error('Portable build contains an external stylesheet reference.');
}
console.log(`Created ${outputFile} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
