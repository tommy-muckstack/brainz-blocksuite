import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import enginePatches from './scripts/engine-patches.json';
const engineRevision=createHash('sha256').update(JSON.stringify(enginePatches)).digest('hex').slice(0,12);
export default defineConfig({
  base: './',
  cacheDir:`node_modules/.vite-brainz-${engineRevision}`,
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  resolve: { dedupe: ['yjs', 'lit', '@preact/signals-core'] },
});
