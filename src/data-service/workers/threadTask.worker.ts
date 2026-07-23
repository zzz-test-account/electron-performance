import { parentPort } from 'node:worker_threads';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * 线程池任务执行体（独立入口，构建为 out/data-service/threadTask.worker.mjs）。
 *
 * 当前任务类型：
 * - archive-copy：把热库中早于水位线的数据 COPY 为 Hive 分区 Parquet（方案 §3.1）。
 *   在独立线程中经 DuckDBInstanceCache.fromCache 共享同一库文件（进程内单实例），
 *   与主数据线程的写连接互不阻塞。
 */

interface TaskMessage {
  id: number;
  task: {
    type: 'archive-copy';
    dbPath: string;
    archiveDir: string;
    watermarkTs: number;
  };
}

parentPort!.on('message', async (msg: TaskMessage) => {
  try {
    const result = await execute(msg.task);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

async function execute(task: TaskMessage['task']): Promise<unknown> {
  switch (task.type) {
    case 'archive-copy': {
      const instance = await DuckDBInstance.fromCache(task.dbPath);
      const conn = await instance.connect();
      try {
        const dir = task.archiveDir.replace(/\\/g, '/').replace(/'/g, "''");
        // PARTITION_BY (dt) 自动生成 dt=YYYY-MM-DD/ 目录树（方案 §3.1），
        // 查询时 glob 路径即分区裁剪
        await conn.run(
          `COPY (
             SELECT ts, channel_id, value,
                    strftime(epoch_ms(ts), '%Y-%m-%d') AS dt
             FROM signals WHERE ts < $1
           ) TO '${dir}' (FORMAT PARQUET, PARTITION_BY (dt), OVERWRITE_OR_IGNORE)`,
          [task.watermarkTs],
        );
        return { done: true };
      } finally {
        conn.closeSync();
      }
    }
    default:
      throw new Error(`未知线程任务：${(task as { type: string }).type}`);
  }
}
