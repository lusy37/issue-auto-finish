import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
export default defineConfig({ root: path.resolve(__dirname), plugins: [vue(), tailwindcss()], resolve: { alias: { '@': path.resolve(__dirname, 'src') } }, server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } } });
