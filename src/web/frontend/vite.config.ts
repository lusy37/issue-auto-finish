import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfigFilePath } from '../../config.js';
import { parse } from 'dotenv';

function resolveBackendPort(): number {
  const fromEnv = process.env.WEB_PORT;
  if (fromEnv) return parseInt(fromEnv, 10);

  const candidates = [resolveConfigFilePath()];

  for (const p of candidates) {
    if (existsSync(p)) {
      const port = parse(readFileSync(p, 'utf-8')).WEB_PORT;
      if (port) return parseInt(port, 10);
    }
  }
  return 3000;
}

const backendPort = resolveBackendPort();
const backendOrigin = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/');
          if (normalizedId.includes('/node_modules/@vue-flow/')) return 'vue-flow';
          if (
            normalizedId.includes('/node_modules/chart.js/') ||
            normalizedId.includes('/node_modules/chartjs-plugin-datalabels/') ||
            normalizedId.includes('/node_modules/vue-chartjs/')
          )
            return 'charts';
          if (normalizedId.includes('/node_modules/vue/')) return 'vue';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backendOrigin,
      '/doc': backendOrigin,
    },
  },
});
