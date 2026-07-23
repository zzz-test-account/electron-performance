import { CHANNELS, IPC_EVENTS, type ChannelName } from '../../../shared/protocol';

/**
 * 端口桥：经 preload 的 dataBridge 向主进程申请逻辑通道端口（方案 §6 通道拓扑）。
 *
 * 路径：renderer → dataBridge.requestPort → main 建 MessageChannelMain →
 * port2 经 preload window.postMessage 两跳转发回本文件。此后渲染进程与
 * 数据服务进程直连，主进程退出数据通路。
 */

const portPromises = new Map<ChannelName, Promise<MessagePort>>();

export function acquirePort(name: ChannelName): Promise<MessagePort> {
  let pending = portPromises.get(name);
  if (!pending) {
    pending = new Promise<MessagePort>((resolve) => {
      const handler = (e: MessageEvent) => {
        const data = e.data as { kind?: string; name?: string } | undefined;
        if (data && data.kind === IPC_EVENTS.PORT_TO_RENDERER && data.name === name && e.ports[0]) {
          window.removeEventListener('message', handler);
          resolve(e.ports[0]);
        }
      };
      window.addEventListener('message', handler);
      window.dataBridge.requestPort(name);
    });
    portPromises.set(name, pending);
  }
  return pending;
}

/** 数据进程重启后端口全部失效，清空缓存使下次访问重新建连 */
export function resetPorts(): void {
  portPromises.clear();
}

export function onDataServiceRestarted(callback: () => void): void {
  window.dataBridge.onDataServiceRestarted(() => {
    resetPorts();
    callback();
  });
}

export { CHANNELS };
