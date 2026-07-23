import { concatColumns, decodeFrame, type DecodedFrame } from '../../../shared/columnar';
import type { FromQueryChannel, ToQueryChannel } from '../../../shared/protocol';
import type { OverviewInfo, QueryOp, SignalLayer, TimeRange } from '../../../shared/types';
import { acquirePort, CHANNELS } from './portBridge';

/**
 * 数据访问 SDK（渲染进程侧唯一数据入口，方案 §4.4）。
 *
 * 职责：
 * - queryId 生命周期管理：同槽位（slot）新查询自动取消前一个（如用户连续拖动 dataZoom）；
 * - 流式帧聚合：列式帧逐帧解码（零拷贝视图），end 时按需拼成连续列；
 * - credit 背压回执：每消费一帧回补一帧额度，防止快查询冲高本进程内存；
 * - 同 key 结果 LRU 缓存：缩放/平移等高频交互的服务端压力削峰。
 *
 * 内存纪律：大结果只以 TypedArray 形态存在，绝不物化为 JS 对象数组。
 */

export interface QueryResult {
  /** 列名 → 连续 TypedArray（JSON 查询时为空 Map） */
  columns: Map<string, Float64Array | Int32Array>;
  rowCount: number;
  elapsedMs: number;
  /** format=json 查询的内联结果（如 meta.overview） */
  json?: unknown;
}

export interface QueryOptions {
  /** 查询槽位：同槽位只允许一个活跃查询，新查询自动取消旧的 */
  slot?: string;
  /** LRU 缓存 key（同 key 直接命中，不再发起查询） */
  cacheKey?: string;
}

interface PendingQuery {
  resolve: (r: QueryResult) => void;
  reject: (e: Error) => void;
  frames: DecodedFrame[];
  json?: unknown;
  startTime: number;
}

class DataClient {
  private port: MessagePort | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingQuery>();
  private slotOwners = new Map<string, number>();
  private lru = new Map<string, QueryResult>();
  private readonly lruCapacity = 32;

  async init(): Promise<void> {
    this.port = await acquirePort(CHANNELS.QUERY);
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data as FromQueryChannel);
  }

  /** 数据进程重启后由 portBridge 触发：清理全部悬挂状态 */
  reset(): void {
    for (const p of this.pending.values()) p.reject(new Error('数据服务进程已重启'));
    this.pending.clear();
    this.slotOwners.clear();
    this.lru.clear();
    this.port = null;
  }

  private onMessage(msg: FromQueryChannel): void {
    const p = this.pending.get(msg.id);
    if (!p) return; // 已取消/已超时的查询，迟到帧直接丢弃
    switch (msg.kind) {
      case 'meta':
        if (msg.format === 'json') p.json = msg.payload;
        break;
      case 'chunk': {
        // 解码是零拷贝的（帧 buffer 上的 TypedArray 视图）
        p.frames.push(decodeFrame(msg.buffer));
        // credit 背压：消费一帧回补一帧（方案 §6）
        this.port?.postMessage({ kind: 'credit', id: msg.id, chunks: 1 } satisfies ToQueryChannel);
        break;
      }
      case 'end':
        this.pending.delete(msg.id);
        p.resolve({
          columns: concatColumns(p.frames),
          rowCount: msg.rowCount,
          elapsedMs: msg.elapsedMs,
          json: p.json,
        });
        break;
      case 'error': {
        this.pending.delete(msg.id);
        const err = new Error(msg.message) as Error & { cancelled?: boolean };
        err.cancelled = msg.cancelled;
        p.reject(err);
        break;
      }
    }
  }

  async query(op: QueryOp, params: Record<string, unknown>, opts: QueryOptions = {}): Promise<QueryResult> {
    if (opts.cacheKey) {
      const hit = this.lru.get(opts.cacheKey);
      if (hit) {
        // LRU：命中后挪到末尾
        this.lru.delete(opts.cacheKey);
        this.lru.set(opts.cacheKey, hit);
        return hit;
      }
    }
    if (!this.port) await this.init();

    // 同槽位自动取消前一个查询（方案 §4.4：交互式查询可取消）
    if (opts.slot) {
      const prev = this.slotOwners.get(opts.slot);
      if (prev != null) this.cancel(prev);
    }

    const id = this.nextId++;
    const resultPromise = new Promise<QueryResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, frames: [], startTime: performance.now() });
    });
    if (opts.slot) this.slotOwners.set(opts.slot, id);
    this.port!.postMessage({ kind: 'query', id, op, params } satisfies ToQueryChannel);

    try {
      const result = await resultPromise;
      if (opts.cacheKey) {
        this.lru.set(opts.cacheKey, result);
        if (this.lru.size > this.lruCapacity) {
          // 淘汰最久未用
          const oldest = this.lru.keys().next().value;
          if (oldest !== undefined) this.lru.delete(oldest);
        }
      }
      return result;
    } finally {
      if (opts.slot && this.slotOwners.get(opts.slot) === id) this.slotOwners.delete(opts.slot);
    }
  }

  cancel(id: number): void {
    if (!this.pending.has(id)) return;
    this.port?.postMessage({ kind: 'cancel', id } satisfies ToQueryChannel);
  }

  // -------------------------------------------------------------------------
  // 面向组件的语义化方法（组件不直接拼 op/params）
  // -------------------------------------------------------------------------

  overview(): Promise<OverviewInfo> {
    return this.query('meta.overview', {}).then((r) => r.json as OverviewInfo);
  }

  signalRange(channelId: number, range: TimeRange, layer: SignalLayer, slot: string): Promise<QueryResult> {
    return this.query(
      'signal.range',
      { channelId, start: range.start, end: range.end, layer },
      { slot, cacheKey: `range:${channelId}:${range.start}:${range.end}:${layer}` },
    );
  }

  signalPage(channelId: number | null, cursor: number | null, limit: number): Promise<QueryResult> {
    return this.query('signal.page', { channelId, cursor, limit });
  }

  boxplotByBucket(channelId: number, range: TimeRange, bucketMs: number, slot: string): Promise<QueryResult> {
    return this.query(
      'stats.boxplot',
      { channelId, start: range.start, end: range.end, bucketMs },
      { slot, cacheKey: `box:${channelId}:${range.start}:${range.end}:${bucketMs}` },
    );
  }

  outliers(channelId: number, range: TimeRange, maxPoints = 500): Promise<QueryResult> {
    return this.query('stats.outliers', { channelId, start: range.start, end: range.end, maxPoints });
  }
}

/** 全局单例（渲染进程内共享一条查询通道） */
export const dataClient = new DataClient();
