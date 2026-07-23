import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * 数据服务进程（Electron utilityProcess）的独立构建配置。
 *
 * 为什么不随 electron-vite 的 main 一起构建：
 * utilityProcess.fork() 需要的是一个磁盘上独立存在的 JS 文件（带完整 Node 环境），
 * 与主进程 bundle 是两套入口、两种生命周期，分开构建职责更清晰。
 *
 * - 输出 ESM（.mjs）：Electron ≥ 28 的 utilityProcess 原生支持 ESM。
 * - @duckdb/node-api 声明 external：它是原生 N-API 模块，必须在运行时从 node_modules 解析。
 * - 线程池 worker 文件（threadTask.worker）作为第二入口独立产出，供 worker_threads 动态加载。
 */
export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'out/data-service',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/data-service/index.ts'),
        'threadTask.worker': resolve(__dirname, 'src/data-service/workers/threadTask.worker.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.mjs`,
    },
    rollupOptions: {
      external: [/^@duckdb\//, /^node:/],
    },
  },
});
