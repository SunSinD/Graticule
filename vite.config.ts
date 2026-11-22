import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const portable = process.env.GRATICULE_PORTABLE === '1';

function precachePlugin(): Plugin {
  return {
    name: 'graticule-precache',
    apply: 'build',
    closeBundle() {
      if (portable) return;

      const root = resolve(process.cwd());
      const dist = resolve(root, 'dist');
      const assetsDir = resolve(dist, 'assets');
      const assets = readdirSync(assetsDir)
        .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
        .sort();
      const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
      const digest = createHash('sha256')
        .update(`${version}\0${assets.join('\0')}`)
        .digest('hex')
        .slice(0, 8);
      const cacheName = `graticule-v${version}-${digest}`;
      const precache = assets.map((name) => JSON.stringify(`./assets/${name}`)).join(',');
      const serviceWorkerPath = resolve(dist, 'sw.js');
      const serviceWorker = readFileSync(serviceWorkerPath, 'utf8')
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
