import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  main: { build: { rollupOptions: { external: ['playwright'], input: `${root}src/main/index.ts` } } },
  preload: { build: { rollupOptions: { input: `${root}src/preload/index.ts`, output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: {
    root: `${root}src/renderer`, plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { rollupOptions: { input: `${root}src/renderer/index.html` } }
  }
});
