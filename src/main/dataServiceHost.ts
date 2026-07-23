import path from 'node:path';
import { createRequire } from 'node:module';
// 经 createRequire 加载 Electron 内置模块（ESM 直接 import 会命中 npm 壳包）
const { utilityProcess } = createRequire(import.meta.url)('electron') as typeof import('electron');
import type { MetricsTickMsg } from '../shared/protocol';

type UtilityProcess = Electron.UtilityProcess;

/**
 * 数据服务进程的宿主管理（主进程侧）。
 *
 * 主进程只做编排不做重活（方案 §2 总原则）：
 * - 拉起 / 监控 / 重启 utilityProcess（DuckDB 所在进程，易崩溃组件与主进程隔离）；
 * - 内存高水位自动重生：数据进程 rss 超高水位且无活跃任务时，通知其排空任务后重启，
 *   把长尾泄漏转化为可控的定期回收（方案 §7）。
 */
export class DataServiceHost {
  private child: UtilityProcess | null = null;
  private restartDelay = 1_000;
  private startedAt = 0;
  private lastMetrics: MetricsTickMsg | null = null;
  private intentionalStop = false;

  /** 数据进程完成一次重启后触发（渲染端需重新建连） */
  onRestarted: (() => void) | null = null;

  /** rss 高水位（MB），超过则优雅重生 */
  private readonly highWaterMb = Number(process.env.DS_HIGH_WATER_MB ?? 2048);

  constructor(private readonly entryPath: string) {}

  start(): void {
    this.intentionalStop = false;
    this.spawn();
  }

  postMessage(message: unknown, transfer?: Electron.MessagePortMain[]): void {
    this.child?.postMessage(message, transfer);
  }

  get metrics(): MetricsTickMsg | null {
    return this.lastMetrics;
  }

  /** 内存治理巡检：高水位时优雅重启（先通知排空，超时兜底强杀） */
  checkMemoryAndRecycle(): void {
    if (!this.lastMetrics || !this.child) return;
    if (this.lastMetrics.rssMb > this.highWaterMb) {
      console.warn(
        `[main] 数据进程 rss=${this.lastMetrics.rssMb}MB 超水位 ${this.highWaterMb}MB，执行排空重生`,
      );
      void this.gracefulRestart();
    }
  }

  async gracefulRestart(): Promise<void> {
    if (!this.child) {
      this.spawn();
      return;
    }
    const old = this.child;
    this.intentionalStop = true;
    old.postMessage({ type: 'shutdown' });
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      old.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) old.kill();
    this.intentionalStop = false;
    this.spawn();
    this.onRestarted?.();
  }

  private spawn(): void {
    const child = utilityProcess.fork(this.entryPath, [], {
      // 数据目录默认 <工程根>/data，与 scripts/seed.mjs 保持一致（README 有说明）
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = Date.now();

    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[ds] ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[ds!] ${d}`));

    child.on('message', (msg: { type?: string; payload?: MetricsTickMsg }) => {
      if (msg?.type === 'metrics' && msg.payload) this.lastMetrics = msg.payload;
    });

    child.on('exit', (code) => {
      this.child = null;
      if (this.intentionalStop) return;
      console.error(`[main] 数据进程退出（code=${code}），${this.restartDelay}ms 后重启`);
      // 稳定运行超过 60s 重置退避；否则指数退避防崩溃风暴
      if (Date.now() - this.startedAt > 60_000) this.restartDelay = 1_000;
      setTimeout(() => {
        this.spawn();
        this.onRestarted?.();
      }, this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    });
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.child) {
      this.child.postMessage({ type: 'shutdown' });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child?.kill();
          resolve();
        }, 5_000);
        this.child?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.child = null;
    }
  }
}

/** 数据服务进程入口文件路径（out/data-service/index.mjs） */
export function dataServiceEntry(mainOutDir: string): string {
  return path.join(mainOutDir, '..', 'data-service', 'index.mjs');
}
