import { createRequire } from 'node:module';
// 经 createRequire 加载 Electron 内置模块（ESM 直接 import 会命中 npm 壳包）
const { ipcMain, MessageChannelMain } = createRequire(import.meta.url)(
  'electron',
) as typeof import('electron');
import { CHANNELS, IPC_EVENTS, type ChannelName } from '../shared/protocol';
import type { DataServiceHost } from './dataServiceHost';

/**
 * 通道接线员（方案 §6 通道拓扑）。
 *
 * 渲染进程申请某逻辑通道时，主进程创建 MessageChannelMain：
 * port1 交数据服务进程、port2 经 webContents.postMessage 转交渲染进程。
 * 此后两端直连通信，主进程完全退出数据通路——
 * 不会成为每秒数万行数据的搬运瓶颈。
 */
export function setupChannelBroker(host: DataServiceHost): void {
  const validNames = new Set<string>(Object.values(CHANNELS));

  ipcMain.on(IPC_EVENTS.REQUEST_PORT, (event, name: string) => {
    if (!validNames.has(name)) {
      console.warn(`[main] 非法通道申请：${String(name)}`);
      return;
    }
    const { port1, port2 } = new MessageChannelMain();
    host.postMessage({ type: IPC_EVENTS.BIND_CHANNEL, name: name as ChannelName }, [port1]);
    event.sender.postMessage(`${IPC_EVENTS.PORT_DELIVERED}:${name}`, null, [port2]);
  });
}
