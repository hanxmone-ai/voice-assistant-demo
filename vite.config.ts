import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'web',
  // Relative paths, so the build works at any URL (GitHub Pages serves it under /voice-assistant-demo/).
  base: './',
  build: { outDir: '../build/web', emptyOutDir: true },
  server: {
    // `npm run dev` (API on 8788) + `npm run dev:web`.
    proxy: { '/api': 'http://localhost:8788' },
  },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
});
