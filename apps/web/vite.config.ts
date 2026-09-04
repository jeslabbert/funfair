import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const SERVER = process.env.FUNFAIR_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        host: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play/index.html'),
        practice: resolve(__dirname, 'practice/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: SERVER, ws: true, changeOrigin: true },
      '/healthz': SERVER,
    },
  },
});
