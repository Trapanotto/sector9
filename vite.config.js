import { defineConfig } from 'vite';

// Relative base so the build works under a sub-path (GitHub Pages: /sector9/).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
});
