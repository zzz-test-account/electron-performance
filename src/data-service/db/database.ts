import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { config } from '../config';

/**
 * DuckDB 实例与连接管理。
 *
 * 并发模型（方案 §2/§3.3）：
 * - DuckDB 跨进程是"单写多读"，因此全局只有本进程持有可写连接，其他进程一律经 IPC 委托写；
 * - 进程内靠 MVCC 支持多连接，写连接唯一（writer），查询连接按需创建（queryEngine 每查询一条，
 *   以便 interrupt 能精确中断单个查询而不误伤他人）。
 */
export interface DatabaseHandle {
  instance: DuckDBInstance;
  /** 全应用唯一写连接：微批写入、预聚合刷新、归档删除都走它 */
  writer: DuckDBConnection;
  dbPath: string;
  archiveDir: string;
}

export async function openDatabase(): Promise<DatabaseHandle> {
  const hotDir = path.join(config.dataDir, 'hot');
  const archiveDir = path.join(config.dataDir, 'archive');
  fs.mkdirSync(hotDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const dbPath = path.join(hotDir, 'hot.duckdb');
  const instance = await DuckDBInstance.create(dbPath, {
    // 留 2 核给渲染与主进程，避免分析查询把整机打满（方案 §2：资源与 UI 共享同一台终端）
    threads: String(Math.max(2, os.cpus().length - 2)),
    memory_limit: config.memoryLimit,
  });
  const writer = await instance.connect();
  return { instance, writer, dbPath, archiveDir };
}
