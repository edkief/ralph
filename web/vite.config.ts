import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into dist/web, which `ralph ui` serves. In development, `npm run dev:web`
// proxies the API to a running `ralph ui` (RALPH_UI_URL, default port 4280).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // Relative asset URLs, so the app works under a reverse proxy's path prefix.
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': process.env.RALPH_UI_URL ?? 'http://127.0.0.1:4280' },
  },
});
