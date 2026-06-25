import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built app is served by the NEXUS daemon's web server (src/web/server.ts)
// from any path, so use relative asset URLs. Dev runs on its own port and talks
// to the daemon's WS on 4242 (start the daemon with NEXUS_WEB_DEV=1 so it skips
// the per-boot token check for the cross-origin dev server).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5174,
    host: '127.0.0.1',
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
