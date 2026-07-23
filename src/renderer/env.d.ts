/// <reference types="vite/client" />

/**
 * preload 暴露的桥接对象类型声明（与 src/preload/index.ts 对应）。
 */
interface DataBridge {
  requestPort(name: string): void;
  onDataServiceRestarted(callback: () => void): void;
}

interface Window {
  dataBridge: DataBridge;
}
