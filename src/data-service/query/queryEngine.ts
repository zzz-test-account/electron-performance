import type { DuckDBConnection, DuckDBDataChunk, DuckDBInstance } from '@duckdb/node-api';
import { DuckDBTypeId } from '@duckdb/node-api';
import { ColType, encodeFrame, type EncodeColumn } from '../../shared/columnar';
import type {
  FromQueryChannel,
  QueryRequestMsg,
  StreamChunkMsg,
  ToQueryChannel,
} from '../../shared/protocol';
import type { ChannelMeta, OverviewInfo } from '../../shared/types';
import { config } from '../config';
import { buildQuery } from './sql';

/** 数据服务进程侧的消息端口（Electron utilityProcess 收到的 MessagePortMain 行为同 Node MessagePort） */
interface PortLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

interface ActiveQuery {
  conn: DuckDBConnection;
  cancelled: boolean;
  /** credit 背压：渲染端按消费速率回补，防止快查询冲高慢消费的渲染进程内存（方案 §6） */
  credit: number;
  creditWaiter: (() => void) | null;
}

/**
 * 查询引擎：参数化执行 → 列式帧分块 → 逐帧回推（credit 背压节流）。
 *
 * 关键设计：
 * - 每个查询独占一条连接（DuckDB 连接创建开销小），使 interrupt 能精确中断单个
 *   查询而不误伤同进程其他查询（方案 §4.4，原生引擎级中断是选原生方案的收益之一）；
 * - 结果强制流式分块，SDK 层不允许无上限全量拉取（方案 §7 内存纪律）；
 * - 帧之间按 credit 节流，渲染端消费一帧回补一帧。
 */
export class QueryEngine {
  private active = new Map<number, ActiveQuery>();

  constructor(
    private readonly instance: DuckDBInstance,
    private readonly port: PortLike,
  ) {}

  handleMessage(msg: ToQueryChannel): void {
    if (msg.kind === 'cancel') {
      const q = this.active.get(msg.id);
      if (q) {
        q.cancelled = true;
        q.conn.interrupt(); // 引擎级中断：流迭代随即抛错结束
      }
      return;
    }
    if (msg.kind === 'credit') {
      const q = this.active.get(msg.id);
      if (q) {
        q.credit += msg.chunks;
        q.creditWaiter?.();
        q.creditWaiter = null;
      }
      return;
    }
    void this.execute(msg);
  }

  get activeCount(): number {
    return this.active.size;
  }

  private async execute(req: QueryRequestMsg): Promise<void> {
    const t0 = performance.now();
    const conn = await this.instance.connect();
    const state: ActiveQuery = { conn, cancelled: false, credit: 4, creditWaiter: null };
    this.active.set(req.id, state);
    try {
      if (req.op === 'meta.overview') {
        await this.executeOverview(req.id, conn);
        return;
      }

      const { sql, params } = buildQuery(req.op, req.params);
      const result = await conn.stream(sql, params);
      this.post({ kind: 'meta', id: req.id, format: 'cols-bin' });

      // 帧聚合器：DuckDB 原生 chunk（默认 2048 行）聚成 ~64k 行的大帧再传输，
      // 摊薄每帧的消息与调度开销
      const acc = new FrameAccumulator(result.columnCount, (i) =>
        result.columnTypeId(i) === DuckDBTypeId.INTEGER ? ColType.I32 : ColType.F64,
        (i) => result.columnName(i),
      );
      let rowCount = 0;
      for await (const chunk of result) {
        acc.push(chunk);
        rowCount += chunk.rowCount;
        while (acc.bufferedRows >= config.frameRows) {
          await this.sendFrame(req.id, acc, state);
        }
      }
      if (acc.bufferedRows > 0) await this.sendFrame(req.id, acc, state);

      this.post({ kind: 'end', id: req.id, rowCount, elapsedMs: performance.now() - t0 });
    } catch (err) {
      this.post({
        kind: 'error',
        id: req.id,
        message: err instanceof Error ? err.message : String(err),
        cancelled: state.cancelled,
      });
    } finally {
      this.active.delete(req.id);
      conn.closeSync();
    }
  }

  /** 库概览是小结果，直接 JSON 内联，不走列式帧 */
  private async executeOverview(id: number, conn: DuckDBConnection): Promise<void> {
    const t0 = performance.now();
    const stats = await conn.run(
      `SELECT count(*) AS total, min(ts) AS min_ts, max(ts) AS max_ts FROM unified`,
    );
    const statsRows = await stats.getRowObjects();
    const row0 = statsRows[0] as Record<string, unknown> | undefined;
    const channelsRes = await conn.run(`SELECT id, name FROM channels ORDER BY id`);
    const channelRows = await channelsRes.getRowObjects();
    const channels: ChannelMeta[] = channelRows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
    }));
    const payload: OverviewInfo = {
      totalRows: Number(row0?.total ?? 0),
      minTs: row0?.min_ts == null ? null : Number(row0.min_ts),
      maxTs: row0?.max_ts == null ? null : Number(row0.max_ts),
      channels,
    };
    this.post({ kind: 'meta', id, format: 'json', payload });
    this.post({ kind: 'end', id, rowCount: 1, elapsedMs: performance.now() - t0 });
  }

  private async sendFrame(id: number, acc: FrameAccumulator, state: ActiveQuery): Promise<void> {
    // credit 背压：无额度时挂起，直到渲染端回补（方案 §6 流式协议自带背压）
    while (state.credit <= 0 && !state.cancelled) {
      await new Promise<void>((resolve) => {
        state.creditWaiter = resolve;
      });
    }
    if (state.cancelled) throw new Error('查询已取消');
    state.credit--;
    const buffer = acc.drainFrame();
    const msg: StreamChunkMsg = { kind: 'chunk', id, buffer };
    // 注意：跨进程的 MessagePortMain 其 transfer 列表只接受端口对象，
    // 传 ArrayBuffer 会抛 "Port at index 0 is not a valid port"——帧按结构化克隆复制。
    // 零拷贝链在渲染进程内部延续：SDK 解码为零拷贝视图，Worker 降采样走 Transferable。
    this.port.postMessage(msg);
  }

  private post(msg: FromQueryChannel): void {
    this.port.postMessage(msg);
  }
}

/**
 * 帧聚合器：把 DuckDB 小块（~2048 行）攒成大帧（~64k 行）。
 * chunk.getColumns() 返回列主序值数组（BIGINT → bigint，这里统一转 number，
 * ms 纪元值远小于 2^53 无精度损失）。
 */
class FrameAccumulator {
  private columns: number[][];
  private rows = 0;

  constructor(
    colCount: number,
    private readonly typeOf: (i: number) => ColType,
    private readonly nameOf: (i: number) => string,
  ) {
    this.columns = Array.from({ length: colCount }, () => []);
  }

  get bufferedRows(): number {
    return this.rows;
  }

  push(chunk: DuckDBDataChunk): void {
    const cols = chunk.getColumns();
    for (let i = 0; i < cols.length; i++) {
      const src = cols[i];
      const dst = this.columns[i];
      for (let j = 0; j < src.length; j++) {
        const v = src[j];
        // null 归零（当前查询均无 NULL 输出，见 columnar.ts 约束说明）
        dst.push(v == null ? 0 : Number(v));
      }
    }
    this.rows += chunk.rowCount;
  }

  drainFrame(): ArrayBuffer {
    const encodeCols: EncodeColumn[] = this.columns.map((values, i) => ({
      name: this.nameOf(i),
      type: this.typeOf(i),
      values,
    }));
    const frame = encodeFrame(encodeCols, this.rows);
    this.columns = this.columns.map(() => []);
    this.rows = 0;
    return frame;
  }
}
