import { defineConfig } from 'vite';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// asset-pipeline documentation / reports that live next to the assets in public/ but are never loaded by the game
const DEV_ONLY = [
  'assets/chars/README.md', 'assets/chars/.gitignore', 'assets/chars/enemy_anims.clips.json',
  'assets/arms/fp_arms_pistol.clips.json', 'assets/arms/penetration_report.json', 'assets/arms/penetration_mesh_check.json',
];

// Relative base so the build works under a sub-path (GitHub Pages: /sector9/).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
  // tmp/ holds throwaway browser profiles of scripts/browser-check.mjs (locked files would crash the watcher)
  server: { watch: { ignored: ['**/tmp/**', '**/dist/**'] } },
  plugins: [{
    name: 's9-strip-dev-files', apply: 'build',
    closeBundle() { for (const f of DEV_ONLY) rmSync(resolve('dist', f), { force: true }); },
  }],
});
