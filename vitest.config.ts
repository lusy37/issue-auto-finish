import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/web/frontend/src') },
  },
  test: {
    setupFiles: ['tests/setup-data.ts'],
    include: ['tests/**/*.test.ts'],
    // 限制真实 Git 和浏览器回归的并行度，避免耗尽本机资源。
    maxWorkers: 2,
    testTimeout: 30000,
    typecheck: {
      enabled: false,
    },
  },
});
