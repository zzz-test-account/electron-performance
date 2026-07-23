import type { DuckDBConnection } from '@duckdb/node-api';
import { ensureUnifiedView } from './schema';
import type { ThreadPool } from '../workers/threadPool';

/**
 * 热 → 冷归档管线（方案 §3.1）。
 *
 * 流程：
 * 1. 归档导出（COPY TO Parquet, PARTITION_BY dt）放到 worker_threads 池执行——
 *    大批量导出属于重型子任务，不占数据服务主线程（方案 §4.3 Node 侧线程池）；
 * 2. 导出成功后，预聚合水位补算（保证被删区间的 L1/L2 桶已物化）；
 * 3. 由全局唯一写连接删除热表对应区间；
 * 4. 刷新统一视图，让后续历史查询穿透到 Parquet（分区裁剪生效）。
 *
 * 查询侧用 glob 路径让文件系统充当过滤器（dt=YYYY-MM-DD/ 目录树）。
 */
export async function archiveBefore(
  pool: ThreadPool,
  writer: DuckDBConnection,
  dbPath: string,
  archiveDir: string,
  watermarkTs: number,
): Promise<{ archived: boolean; rows: number }> {
  // 无早于水位线的数据则跳过
  const res = await writer.run(`SELECT count(*) AS n FROM signals WHERE ts < $1`, [watermarkTs]);
  const rows = Number((await res.getRowObjects())[0]?.n ?? 0);
  if (rows === 0) return { archived: false, rows: 0 };

  // 1) 线程池中执行 COPY 导出（只读 + 文件写入，不经写连接）
  await pool.run<void>({
    type: 'archive-copy',
    dbPath,
    archiveDir,
    watermarkTs,
  });

  // 2) 补算归档区间的预聚合桶（L1/L2 只从热表派生，删除前必须物化完毕）
  await writer.run(`DELETE FROM signals_l1 WHERE ts < $1`, [watermarkTs]);
  await writer.run(
    `INSERT INTO signals_l1
       SELECT (ts // 60000) * 60000, channel_id, avg(value), min(value), max(value), count(*)
       FROM signals WHERE ts < $1 GROUP BY 1, 2`,
    [watermarkTs],
  );
  await writer.run(`DELETE FROM signals_l2 WHERE ts < $1`, [watermarkTs]);
  await writer.run(
    `INSERT INTO signals_l2
       SELECT (ts // 3600000) * 3600000, channel_id, avg(value), min(value), max(value), count(*)
       FROM signals WHERE ts < $1 GROUP BY 1, 2`,
    [watermarkTs],
  );

  // 3) 唯一写连接删除热表已归档区间
  await writer.run(`DELETE FROM signals WHERE ts < $1`, [watermarkTs]);

  // 4) 刷新统一视图（首次产生归档文件后，unified 才会 UNION read_parquet）
  await ensureUnifiedView(writer, archiveDir);
  return { archived: true, rows };
}
