import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// GitHub Pages serves the site from /riftcast/. Override with BASE_PATH for other hosts.
const base = process.env.BASE_PATH ?? '/riftcast/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        gallery: resolve(import.meta.dirname, 'vfx-gallery/index.html'),
      },
    },
  },
  server: { host: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
