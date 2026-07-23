/**
 * 开发启动器：先构建 data-service，再启动 electron-vite dev。
 *
 * 为什么需要它：本机环境若设置了 ELECTRON_RUN_AS_NODE=1（部分 AI/Node 工具链会全局设置），
 * Electron 二进制会退化为纯 Node 运行——内置 'electron' 模块不可解析、窗口无法创建。
 * 启动前显式清除该变量，保证应用以真正的 Electron 运行时启动（跨平台，不依赖 shell 语法）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

delete process.env.ELECTRON_RUN_AS_NODE;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

const node = process.execPath;
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const electronViteBin = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');

await run(node, [viteBin, 'build', '--config', 'vite.data-service.config.ts']);
await run(node, [electronViteBin, 'dev']);
