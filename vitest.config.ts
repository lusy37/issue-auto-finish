import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/web/frontend/src') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    typecheck: {
      enabled: false,
    },
  },
});
