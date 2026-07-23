import path from 'node:path';

/**
 * 数据服务进程集中配置。
 * 均可经环境变量覆盖（主进程在 utilityProcess.fork 时注入，见 main/dataServiceHost.ts），
 * 默认值面向演示场景调小，生产取值参考方案文档 §3.3 / §7。
 */
export const config = {
  /** 数据根目录：默认 <工程根>/data，热库与冷归档都在其下 */
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('data'),
  /** DuckDB 内存预算：超出后引擎自动落盘（temporary directory）而非 OOM，见方案 §7 */
  memoryLimit: process.env.DB_MEMORY_LIMIT ?? '1536MB',
  /** 微批触发阈值：凑够 N 行或 T 毫秒，先到先触发（方案 §3.3） */
  flushRows: Number(process.env.FLUSH_ROWS ?? 50_000),
  flushMs: Number(process.env.FLUSH_MS ?? 500),
  /** 接入缓冲硬顶（行）：水位超过 80% 触发背压降速信号，保证内存有硬顶 */
  queueCapacityRows: Number(process.env.QUEUE_CAPACITY_ROWS ?? 2_000_000),
  /** 热表保留窗口：早于该窗口的数据在空闲时归档为 Hive 分区 Parquet（方案 §3.1/§3.2） */
  hotRetentionMs: Number(process.env.HOT_RETENTION_MS ?? 3 * 24 * 3600_000),
  /** 归档巡检间隔 */
  archiveIntervalMs: Number(process.env.ARCHIVE_INTERVAL_MS ?? 10 * 60_000),
  /** 预聚合刷新节流：每次微批提交后最多每隔该间隔重算一次受影响桶 */
  aggregateRefreshMs: Number(process.env.AGG_REFRESH_MS ?? 5_000),
  /** 每个传输帧的最大行数（控制单条消息体积，配合 credit 背压） */
  frameRows: Number(process.env.FRAME_ROWS ?? 65_536),
  /** 模拟数据源默认速率（行/秒）与通道数 */
  simRate: Number(process.env.SIM_RATE ?? 10_000),
  simChannels: Number(process.env.SIM_CHANNELS ?? 4),
} as const;
