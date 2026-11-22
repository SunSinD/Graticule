import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const portable = process.env.GRATICULE_PORTABLE === '1';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || './',
  plugins: [react()],
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
