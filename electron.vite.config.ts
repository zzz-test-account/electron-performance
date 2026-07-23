import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

/**
 * electron-vite 统一构建三端：
 * - main/preload：externalizeDepsPlugin 把 dependencies 外置（运行时从 node_modules 加载），
 *   其中 @duckdb/node-api 为原生模块，绝不能打包进 bundle。
 * - renderer：普通 Web 构建，Worker 走 Vite 原生 `new Worker(new URL(...))` 方案。
 *
 * 注意：数据服务进程（utilityProcess 入口）不在此处构建，
 * 见 vite.data-service.config.ts（独立 Node 目标构建，输出 out/data-service/index.mjs）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/main' },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [vue()],
    build: { outDir: resolve(__dirname, 'out/renderer') },
    worker: { format: 'es' },
  },
});
