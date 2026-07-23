import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config';
import { openDatabase, type DatabaseHandle } from './db/database';
import { applySchema, ensureChannels, ensureUnifiedView } from './db/schema';
import { archiveBefore } from './db/archive';
import { BatchWriter } from './write/batchWriter';
import { QueryEngine } from './query/queryEngine';
import { ThreadPool } from './workers/threadPool';
import { Simulator } from './simulator';
import { CHANNELS, IPC_EVENTS } from '../shared/protocol';
import type {
  FromSubscribeChannel,
  FromWriteChannel,
  MetricsTickMsg,
  ToQueryChannel,
  ToWriteChannel,
} from '../shared/protocol';

/**
 * 数据服务进程入口（Electron utilityProcess，完整 Node.js 环境）。
 *
 * 职责（方案 §2）：
 * - 独占 DuckDB 原生引擎，是全局唯一写者；
 * - 经 MessagePort 与渲染进程直连通信（主进程只建连，退出数据通路）；
 * - 查询 / 写入 / 订阅三通道独立，互不队头阻塞。
 */

interface PortLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  on(event: 'message', listener: (data: never) => void): void;
  on(event: 'close', listener: () => void): void;
  start(): void;
}

/** utilityProcess 的父端口（Electron 注入的 process.parentPort，@types/node 中无声明，此处收窄类型） */
const parentPort = (
  process as unknown as {
    parentPort: {
      postMessage(message: unknown): void;
      on(
        event: 'message',
        listener: (event: { data?: unknown; ports?: PortLike[] } | unknown) => void,
      ): void;
    };
  }
).parentPort;

const subscribers = new Set<PortLike>();

async function main(): Promise<void> {
  const db: DatabaseHandle = await openDatabase();
  await applySchema(db.writer);
  await ensureChannels(db.writer, config.simChannels);
  await ensureUnifiedView(db.writer, db.archiveDir);

  const batchWriter = new BatchWriter(db.writer);
  const simulator = new Simulator(batchWriter);
  batchWriter.onBackpressure = (level) => simulator.onBackpressure(level);

  const pool = new ThreadPool(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'threadTask.worker.mjs'),
  );

  // —— 微批提交后向订阅者广播增量通知（拉模式刷新信号，方案 §6 订阅通道） ——
  batchWriter.onFlush = ({ count, maxTs }) => {
    broadcast({ kind: 'ingest', maxTs, count });
  };

  // —— 通道绑定：主进程（接线员）发来 {type: BIND_CHANNEL, name} + port ——
  parentPort.on('message', (event) => {
    const e = event as { data?: unknown; ports?: PortLike[] };
    const msg = (e?.data ?? event) as { type?: string; name?: string };
    if (msg?.type === IPC_EVENTS.BIND_CHANNEL && e?.ports?.[0]) {
      bindChannel(msg.name as string, e.ports[0], db, batchWriter, simulator);
      return;
    }
    if (msg?.type === 'shutdown') {
      void gracefulShutdown(batchWriter, pool, db);
    }
  });

  // —— 每秒运行指标：订阅通道推送 + 上报主进程（内存高水位重生决策依据，方案 §7） ——
  setInterval(() => {
    const mem = process.memoryUsage() as NodeJS.MemoryUsage & { arrayBuffers?: number };
    const tick: MetricsTickMsg = {
      kind: 'tick',
      writtenTotal: batchWriter.writtenTotal,
      rowsPerSec: batchWriter.drainWrittenCounter(),
      queueLevel: batchWriter.queueLevel,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      // 堆外内存（ArrayBuffer 累积）是长运行内存膨胀头号元凶，必须盯这个字段（方案 §7）
      arrayBuffersMb: Math.round(((mem.arrayBuffers ?? 0) / 1024 / 1024) * 10) / 10,
    };
    broadcast(tick);
    parentPort.postMessage({ type: 'metrics', payload: tick });
  }, 1000);

  // —— 空闲归档巡检：早于保留窗口的热数据转 Hive 分区 Parquet（方案 §3.1） ——
  const runArchive = async () => {
    try {
      const watermark = Date.now() - config.hotRetentionMs;
      const r = await archiveBefore(pool, db.writer, db.dbPath, db.archiveDir, watermark);
      if (r.archived) console.log(`[data-service] 归档完成：${r.rows} 行 → Parquet`);
    } catch (err) {
      console.error('[data-service] 归档失败：', err);
    }
  };
  setInterval(() => void runArchive(), config.archiveIntervalMs);
  setTimeout(() => void runArchive(), 15_000); // 启动后先巡检一次（seed 的历史数据会即刻归档演示）

  // 演示数据源默认开启（UI 可停/调速）
  simulator.start();
  console.log(
    `[data-service] 就绪：db=${db.dbPath}，rate=${config.simRate} 行/秒，channels=${config.simChannels}`,
  );
}

function bindChannel(
  name: string,
  port: PortLike,
  db: DatabaseHandle,
  batchWriter: BatchWriter,
  simulator: Simulator,
): void {
  port.start();
  switch (name) {
    case CHANNELS.QUERY: {
      const engine = new QueryEngine(db.instance, port);
      port.on('message', (e) => engine.handleMessage(unwrapPortMessage(e) as ToQueryChannel));
      break;
    }
    case CHANNELS.WRITE:
      port.on('message', (e) => {
        const msg = unwrapPortMessage(e) as ToWriteChannel;
        if (msg.kind === 'write.rows') {
          batchWriter.enqueue(msg.rows.map(([ts, channelId, value]) => ({ ts, channelId, value })));
          // 背压反馈经写入通道回传
          const level = batchWriter.queueLevel;
          if (level > 0.8) {
            const bp: FromWriteChannel = { kind: 'backpressure', level };
            port.postMessage(bp);
          }
        } else if (msg.kind === 'sim.control') {
          if (msg.rate != null) simulator.setRate(msg.rate);
          if (msg.running === true) simulator.start();
          if (msg.running === false) simulator.stop();
        }
      });
      break;
    case CHANNELS.SUBSCRIBE:
      subscribers.add(port);
      port.on('close', () => subscribers.delete(port));
      break;
    default:
      console.warn(`[data-service] 未知通道：${name}`);
  }
}

function broadcast(msg: FromSubscribeChannel): void {
  for (const port of subscribers) {
    try {
      port.postMessage(msg);
    } catch {
      subscribers.delete(port); // 订阅端已销毁
    }
  }
}

/**
 * 端口消息解包：Electron 的 MessagePortMain 其 message 事件载荷为 { data, ports } 事件对象，
 * 而 Node 的 MessagePort 直接回调裸数据。utilityProcess 收到的是前者，
 * 不做解包会把事件对象当请求体解析（kind 为 undefined，查询静默失败）。
 */
function unwrapPortMessage(e: unknown): unknown {
  if (e != null && typeof e === 'object' && 'data' in (e as Record<string, unknown>)) {
    return (e as { data: unknown }).data;
  }
  return e;
}

async function gracefulShutdown(
  batchWriter: BatchWriter,
  pool: ThreadPool,
  db: DatabaseHandle,
): Promise<void> {
  console.log('[data-service] 收到退出指令，排空写入队列后退出…');
  await batchWriter.drain();
  await pool.destroy();
  db.instance.closeSync();
  process.exit(0);
}

main().catch((err) => {
  console.error('[data-service] 启动失败：', err);
  process.exit(1);
});
