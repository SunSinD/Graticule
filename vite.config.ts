import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const portable = process.env.GRATICULE_PORTABLE === '1';

function listBundledAssets(directory: string, prefix = 'assets'): string[] {
  const absolute = resolve(directory);
  return readdirSync(absolute).flatMap((name) => {
    const path = resolve(absolute, name);
    if (statSync(path).isDirectory()) return listBundledAssets(path, `${prefix}/${name}`);
    return name.endsWith('.js') || name.endsWith('.css') ? [`${prefix}/${name}`] : [];
  });
}

const STATIC_FILES = ['index.html', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png'];

function precachePlugin(): Plugin {
  return {
    name: 'graticule-precache',
    apply: 'build',
    closeBundle() {
      if (portable) return;

      const root = resolve(process.cwd());
      const dist = resolve(root, 'dist');
      const assetsDir = resolve(dist, 'assets');
      const assets = listBundledAssets(assetsDir)
        .map((asset) => asset.slice('assets/'.length))
        .sort();
      const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
      const serviceWorkerPath = resolve(dist, 'sw.js');
      const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8');
      const hash = createHash('sha256').update(`${version}\0${assets.join('\0')}`);
      // A worker only change must never reuse the cache of the build it replaces.
      hash.update('\0sw.js\0').update(createHash('sha256').update(serviceWorkerSource).digest('hex'));
      // The page and static files keep the same names between builds, so their contents go into the cache name.
      for (const name of STATIC_FILES) {
        const path = resolve(dist, name);
        if (!existsSync(path)) continue;
        hash.update(`\0${name}\0`).update(createHash('sha256').update(readFileSync(path)).digest('hex'));
      }
      const digest = hash.digest('hex').slice(0, 8);
      const cacheName = `graticule-v${version}-${digest}`;
      const precache = assets.map((name) => JSON.stringify(`./assets/${name}`)).join(',');
      const serviceWorker = serviceWorkerSource
        .replaceAll('__GRATICULE_CACHE__', cacheName)
        .replace('/*__GRATICULE_PRECACHE__*/', precache);
      writeFileSync(serviceWorkerPath, serviceWorker);
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || './',
  plugins: [react(), precachePlugin()],
  worker: {
    format: 'es',
  },
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: portable ? 'dist-portable/tmp' : 'dist',
    rollupOptions: portable
      ? {
          output: {
            inlineDynamicImports: true,
          },
        }
      : undefined,
  },
});
