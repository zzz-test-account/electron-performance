import type { DuckDBConnection } from '@duckdb/node-api';
import { config } from '../config';
import type { SignalRow } from '../../shared/types';

/**
 * 高频写入管线：接入缓冲 → 微批聚合 → Appender 批量提交（方案 §3.3）。
 *
 * 核心思想：把"每秒数千次小写入"在应用层合并成"每秒几次大写入"——
 * 凑够 flushRows 行或超过 flushMs 毫秒（先到先触发）后，在一个事务内用
 * Appender 直写存储层（比逐条 INSERT 快 10–100 倍）。
 *
 * 可靠性语义：提交成功才出队（至少一次不丢）；队列水位超阈值发出背压信号，
 * 生产端（模拟器/采集端）应降速，保证内存占用有硬顶。
 */
export class BatchWriter {
  private queue: SignalRow[][] = [];
  private bufferedRows = 0;
  private flushing = false;
  private flushTimer: ReturnType<typeof setInterval>;
  private lastAggregateRefresh = 0;

  /** 运行指标（订阅通道 tick 用） */
  writtenTotal = 0;
  private writtenSinceTick = 0;

  constructor(private readonly writer: DuckDBConnection) {
    this.flushTimer = setInterval(() => {
      if (this.bufferedRows > 0) void this.flush();
    }, config.flushMs);
  }

  /** 微批提交完成的回调（增量通知 / 预聚合刷新挂接点） */
  onFlush: ((info: { count: number; maxTs: number }) => void) | null = null;
  /** 背压回调：level ∈ [0,1]，超过 0.8 时生产端应降速（方案 §3.3） */
  onBackpressure: ((level: number) => void) | null = null;

  /** 接入一批行（调用方无需等待提交，提交结果经 onFlush 异步确认） */
  enqueue(rows: SignalRow[]): void {
    if (rows.length === 0) return;
    this.queue.push(rows);
    this.bufferedRows += rows.length;
    const level = this.queueLevel;
    if (level > 0.8) this.onBackpressure?.(level);
    if (this.bufferedRows >= config.flushRows) void this.flush();
  }

  get queueLevel(): number {
    return this.bufferedRows / config.queueCapacityRows;
  }

  /** 取走自上次调用以来的写入行数（速率统计用） */
  drainWrittenCounter(): number {
    const n = this.writtenSinceTick;
    this.writtenSinceTick = 0;
    return n;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.bufferedRows === 0) return;
    this.flushing = true;
    const batches = this.queue.splice(0);
    this.bufferedRows = 0;

    let count = 0;
    let maxTs = 0;
    try {
      await this.writer.run('BEGIN TRANSACTION');
      const appender = await this.writer.createAppender('signals');
      for (const batch of batches) {
        for (const row of batch) {
          // Appender 绕过 SQL 解析直写存储层（方案 §3.3）
          appender.appendBigInt(BigInt(row.ts));
          appender.appendInteger(row.channelId);
          appender.appendDouble(row.value);
          appender.endRow();
          count++;
          if (row.ts > maxTs) maxTs = row.ts;
        }
      }
      appender.closeSync();
      await this.writer.run('COMMIT');

      this.writtenTotal += count;
      this.writtenSinceTick += count;
      this.onFlush?.({ count, maxTs });
      // 预聚合金字塔随写入增量维护（节流到每 aggregateRefreshMs 一次）
      await this.refreshAggregatesThrottled(maxTs);
    } catch (err) {
      await this.writer.run('ROLLBACK').catch(() => {});
      // 至少一次语义：失败批次重新入队，等待下一轮 flush（避免静默丢数据）
      this.queue.unshift(...batches);
      this.bufferedRows += batches.reduce((s, b) => s + b.length, 0);
      console.error('[batch-writer] flush 失败，批次已回队：', err);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 增量刷新受影响的时间桶：删除水位之后的旧桶再按热表重算。
   * L1 分钟桶 / L2 小时桶（方案 §5.1 预聚合金字塔）。
   */
  private async refreshAggregatesThrottled(latestTs: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastAggregateRefresh < config.aggregateRefreshMs) return;
    this.lastAggregateRefresh = now;
    // 回退一个完整小时桶，保证正在写入的"半桶"也被覆盖重算
    const fromMinute = Math.floor((latestTs - 3_600_000) / 60_000) * 60_000;
    await this.writer.run(
      `DELETE FROM signals_l1 WHERE ts >= $1`, [fromMinute],
    );
    await this.writer.run(
      `INSERT INTO signals_l1
         SELECT (ts // 60000) * 60000 AS ts, channel_id,
                avg(value) AS avg_v, min(value) AS min_v, max(value) AS max_v, count(*) AS n
         FROM signals WHERE ts >= $1
         GROUP BY 1, 2`, [fromMinute],
    );
    const fromHour = Math.floor((latestTs - 86_400_000) / 3_600_000) * 3_600_000;
    await this.writer.run(`DELETE FROM signals_l2 WHERE ts >= $1`, [fromHour]);
    await this.writer.run(
      `INSERT INTO signals_l2
         SELECT (ts // 3600000) * 3600000 AS ts, channel_id,
                avg(value) AS avg_v, min(value) AS min_v, max(value) AS max_v, count(*) AS n
         FROM signals WHERE ts >= $1
         GROUP BY 1, 2`, [fromHour],
    );
  }

  /** 排空并停止（数据进程优雅退出前调用） */
  async drain(): Promise<void> {
    clearInterval(this.flushTimer);
    while (this.bufferedRows > 0) {
      await this.flush();
      // flush 失败会回队，避免死循环：失败后直接放弃并由上层记录
      if (this.bufferedRows > 0 && !this.flushing) break;
    }
  }
}
