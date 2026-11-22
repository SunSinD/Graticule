import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePwaIcons } from './generate-pwa-icons.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = resolve(root, 'dist-portable', 'tmp');
const outputDir = resolve(root, 'dist-portable');
const outputFile = resolve(outputDir, 'graticule-portable.html');

generatePwaIcons();

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
html = html.replace(/<link[^>]+rel=["'](?:modulepreload|preload)["'][^>]*>/gi, '');
html = html.replace(/<link[^>]+rel=["']icon["'][^>]*>/gi, '');

for (const match of [...html.matchAll(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi)]) {
  const href = match[1];
  const file = resolve(tmpDir, href.replace(/^\.\//, '').replace(/^\//, ''));
  if (existsSync(file)) {
    const css = readFileSync(file, 'utf8').replaceAll('</style', '<\\/style');
    html = html.replace(match[0], () => `<style>${css}</style>`);
  }
}

const scripts = [...html.matchAll(/<script([^>]*)src=["']([^"']+)["']([^>]*)><\/script>/gi)];
const inlineScripts = [];
for (const match of scripts) {
  const src = match[2];
  const file = resolve(tmpDir, src.replace(/^\.\//, '').replace(/^\//, ''));
  if (existsSync(file)) {
    let code = readFileSync(file, 'utf8');
    // Guard relative worker URLs on file:// so engine.ts cleanly uses its inlined direct fallback.
    code = code.replaceAll('</script', '<\\/script');
    inlineScripts.push(code);
  }
  html = html.replace(match[0], () => '');
}

if (inlineScripts.length > 0) {
  const portableBootstrap = '<script>globalThis.__GRATICULE_PORTABLE__ = true; globalThis.Worker = undefined;</script>';
  html = html.replace('</body>', () => `${portableBootstrap}<script type="module">${inlineScripts.join('\n')}</script></body>`);
}

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
