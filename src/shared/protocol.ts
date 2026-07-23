import type { QueryOp } from './types';

/**
 * 跨进程通信协议（三端共享的唯一事实来源）。
 *
 * 通道拓扑（对应方案文档 §6）：
 * 主进程只在建连时充当"接线员"——为每个逻辑通道创建 MessageChannelMain，
 * port1 交数据服务进程、port2 经 preload 转交渲染进程，此后两端直连、主进程退出数据通路。
 * 查询 / 写入 / 订阅三条通道相互独立，避免队头阻塞。
 */

/** 逻辑通道名（preload 申请、主进程分发、数据服务绑定均以此为准） */
export const CHANNELS = {
  QUERY: 'query',
  WRITE: 'write',
  SUBSCRIBE: 'subscribe',
} as const;
export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/** preload 与主进程之间的建连 IPC 事件名 */
export const IPC_EVENTS = {
  /** preload → main：请求为当前渲染进程建立某逻辑通道 */
  REQUEST_PORT: 'data-channel:request',
  /** main → preload：端口交付（事件名后接通道名，如 data-channel:port:query） */
  PORT_DELIVERED: 'data-channel:port',
  /** preload → 渲染主世界（window.postMessage）：端口转发 */
  PORT_TO_RENDERER: 'data-channel:to-renderer',
  /** main → 数据服务进程：绑定通道端口 */
  BIND_CHANNEL: 'data-channel:bind',
} as const;

// ---------------------------------------------------------------------------
// 查询通道：渲染端 → 数据服务
// ---------------------------------------------------------------------------

/** 查询请求：id 由 SDK 单调分配，取消/流块均以此关联 */
export interface QueryRequestMsg {
  kind: 'query';
  id: number;
  op: QueryOp;
  params: Record<string, unknown>;
}

/** 查询取消：数据服务对对应连接调用 interrupt（原生 DuckDB 支持引擎级中断，见方案 §4.4） */
export interface QueryCancelMsg {
  kind: 'cancel';
  id: number;
}

/** credit 背压回执：渲染端每消费一帧回补额度，数据服务按额度推送（方案 §6 流式背压） */
export interface QueryCreditMsg {
  kind: 'credit';
  id: number;
  chunks: number;
}

export type ToQueryChannel = QueryRequestMsg | QueryCancelMsg | QueryCreditMsg;

// ---------------------------------------------------------------------------
// 查询通道：数据服务 → 渲染端（流式响应）
// ---------------------------------------------------------------------------

/**
 * 流开始：声明负载格式。
 * - `cols-bin`：自定义列式二进制帧（见 data-service/query/columnarCodec.ts），
 *   设计目标与 Arrow IPC 一致——列式布局 + TypedArray 视图 + Transferable 零拷贝。
 *   说明：@duckdb/node-api 目前不暴露引擎侧 Arrow IPC 序列化（C API 的 duckdb_arrow 未上翻），
 *   在 Node 侧经 apache-arrow 二次打包反而多一次拷贝，故采用等效的轻量列式帧。
 * - `json`：小结果（如库概览）直接内联，不再有后续 chunk。
 */
export interface StreamMetaMsg {
  kind: 'meta';
  id: number;
  format: 'cols-bin' | 'json';
  /** format=json 时结果直接内联于此 */
  payload?: unknown;
}

/** 列式二进制帧分块（跨进程结构化克隆；进程内解码为零拷贝视图，见 columnar.ts 说明） */
export interface StreamChunkMsg {
  kind: 'chunk';
  id: number;
  buffer: ArrayBuffer;
}

export interface StreamEndMsg {
  kind: 'end';
  id: number;
  rowCount: number;
  elapsedMs: number;
}

export interface StreamErrorMsg {
  kind: 'error';
  id: number;
  message: string;
  /** 因 cancel 中断也属于 error 通道，用此标志区分 */
  cancelled: boolean;
}

export type FromQueryChannel = StreamMetaMsg | StreamChunkMsg | StreamEndMsg | StreamErrorMsg;

// ---------------------------------------------------------------------------
// 写入通道（全应用唯一写者入口，方案 §3.3）
// ---------------------------------------------------------------------------

/** 追加行：[ts, channelId, value]，进入数据服务的微批聚合队列 */
export interface WriteRowsMsg {
  kind: 'write.rows';
  rows: [number, number, number][];
}

/** 模拟数据源控制（演示用）：开关与速率调节 */
export interface SimControlMsg {
  kind: 'sim.control';
  running?: boolean;
  /** 目标行/秒 */
  rate?: number;
}

export type ToWriteChannel = WriteRowsMsg | SimControlMsg;

/** 背压信号：接入队列水位超过阈值时下发，生产端应降速（方案 §3.3 水位 >80% 降速） */
export interface BackpressureMsg {
  kind: 'backpressure';
  /** 0~1，队列水位 */
  level: number;
}

export type FromWriteChannel = BackpressureMsg;

// ---------------------------------------------------------------------------
// 订阅通道（数据服务 → 渲染端，单向推送）
// ---------------------------------------------------------------------------

/** 每秒运行指标：写入速率 / 队列水位 / 内存水位（内存治理可视化，方案 §7） */
export interface MetricsTickMsg {
  kind: 'tick';
  writtenTotal: number;
  rowsPerSec: number;
  queueLevel: number;
  /** 数据服务进程内存（MB） */
  rssMb: number;
  arrayBuffersMb: number;
}

/** 微批提交完成的增量通知：渲染端据此刷新视口（拉模式，增量 Arrow 推送为预留扩展点） */
export interface IngestMsg {
  kind: 'ingest';
  maxTs: number;
  count: number;
}

export type FromSubscribeChannel = MetricsTickMsg | IngestMsg;
