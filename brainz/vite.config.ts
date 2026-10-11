import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  resolve: { dedupe: ['yjs', 'lit', '@preact/signals-core'] },
});
