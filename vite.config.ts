import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // Two pages: Launchpad, and the Music-only page for a music-only sign-in (server/src/access.ts),
    // which bundles only what it shows.
    rollupOptions: { input: { main: fileURLToPath(new URL('web/index.html', import.meta.url)), guest: fileURLToPath(new URL('web/guest.html', import.meta.url)) } },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
});
