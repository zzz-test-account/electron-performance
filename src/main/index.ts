import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// ESM 下 'electron' 会被 Node 解析到 npm 壳包（导出二进制路径字符串），
// 必须经 createRequire 走 Electron 的 CJS 模块钩子才能拿到内置 API
const { app, BrowserWindow, session } = createRequire(import.meta.url)(
  'electron',
) as typeof import('electron');
import { DataServiceHost, dataServiceEntry } from './dataServiceHost';
import { setupChannelBroker } from './channelBroker';

type BrowserWindowType = Electron.BrowserWindow;

/**
 * 主进程：只做窗口、建连接线、任务编排，不做任何 CPU 密集工作
 * （方案 §2 总原则：主进程做重活会冻结所有渲染进程）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindowType | null = null;
let host: DataServiceHost | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Performance Demo — 大数据存储与高性能计算',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      // preload 为 ESM（.mjs）时需关闭 sandbox；渲染进程本身不启用 Node 集成，攻击面不变
      sandbox: false,
      nodeIntegration: false,
    },
  });

  // 数据进程重启后通知渲染端重新建连
  host!.onRestarted = () => {
    mainWindow?.webContents.send('data-service:restarted');
  };

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 跨域隔离头注入（方案 §8.4，默认关闭）：
 * 仅当压测证明需要 SharedArrayBuffer / WASM threads 时，设环境变量
 * ENABLE_CROSS_ORIGIN_ISOLATION=1 开启。注意 COEP 会拦截未 opt-in 的跨域资源，
 * 本工程资源全部本地自包含，可安全开启。
 */
function setupCrossOriginIsolationIfEnabled(): void {
  if (process.env.ENABLE_CROSS_ORIGIN_ISOLATION !== '1') return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });
  console.log('[main] 跨域隔离已启用（crossOriginIsolated=true，解锁 SharedArrayBuffer）');
}

app.whenReady().then(async () => {
  setupCrossOriginIsolationIfEnabled();

  host = new DataServiceHost(dataServiceEntry(__dirname));
  host.start();
  setupChannelBroker(host);

  // 内存治理巡检（方案 §7）：盯 rss 与 arrayBuffers 趋势，高水位自动重生
  setInterval(() => host?.checkMemoryAndRecycle(), 60_000);

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void host?.stop();
});
