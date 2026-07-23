/// <reference lib="dom" />
import { createRequire } from 'node:module';
// 经 createRequire 加载 Electron 内置模块（ESM 直接 import 会命中 npm 壳包）
const { contextBridge, ipcRenderer } = createRequire(import.meta.url)(
  'electron',
) as typeof import('electron');
import { IPC_EVENTS } from '../shared/protocol';

/**
 * preload：contextIsolation 下的最小桥接面。
 *
 * 渲染进程拿不到 Node/Electron API，只拿到 dataBridge：
 * - requestPort(name)：向主进程申请逻辑通道端口。主进程经 webContents.postMessage
 *   把 MessagePort 送到隔离世界，这里再用 window.postMessage + Transferable
 *   转发到渲染主世界（Electron 官方推荐的两跳模式）。
 * - onDataServiceRestarted(cb)：数据进程重启通知（渲染端据此重新建连）。
 */

const VALID_CHANNELS = new Set(['query', 'write', 'subscribe']);

contextBridge.exposeInMainWorld('dataBridge', {
  requestPort(name: string): void {
    if (!VALID_CHANNELS.has(name)) throw new Error(`非法通道名：${name}`);
    ipcRenderer.once(`${IPC_EVENTS.PORT_DELIVERED}:${name}`, (event) => {
      window.postMessage({ kind: IPC_EVENTS.PORT_TO_RENDERER, name }, '*', [...event.ports]);
    });
    ipcRenderer.send(IPC_EVENTS.REQUEST_PORT, name);
  },
  onDataServiceRestarted(callback: () => void): void {
    ipcRenderer.on('data-service:restarted', () => callback());
  },
});
