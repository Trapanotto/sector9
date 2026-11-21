import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// Standalone viewer for the character assets. Serves the repo's public/ folder so the pages load
// exactly the files the game ships:  npx vite --config tools/char-viewer/vite.config.js
export default defineConfig({
  root: here,
  publicDir: path.resolve(here, '../../public'),
  server: { port: 5183, strictPort: true },
});
