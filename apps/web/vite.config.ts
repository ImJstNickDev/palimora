import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const reviewOrigin = process.env.PALIMORA_REVIEW_ORIGIN;
const reviewHost = reviewOrigin ? new URL(reviewOrigin).hostname : undefined;

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.VITE_CACHE_DIR,
  server: {
    strictPort: true,
    allowedHosts: reviewHost ? [reviewHost] : undefined,
    hmr: reviewHost ? { host: reviewHost, protocol: 'wss', clientPort: 443 } : undefined,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
