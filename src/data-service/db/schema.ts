import fs from 'node:fs';
import path from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
// vite `?raw` 导入：schema SQL 与 scripts/seed.mjs 共用同一文件，避免两处维护漂移
import schemaSql from './schema.sql?raw';

/**
 * 建表与统一视图维护。
 */

export async function applySchema(conn: DuckDBConnection): Promise<void> {
  // 逐句执行（schema.sql 中有多条语句）
  for (const stmt of schemaSql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await conn.run(stmt);
  }
}

/** 注册通道字典（模拟源/种子数据共用），字符串维度字典化为小整数（方案 §3.2） */
export async function ensureChannels(conn: DuckDBConnection, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await conn.run('INSERT OR IGNORE INTO channels VALUES ($1, $2)', [i, `CH-${i}`]);
  }
}

/**
 * 建立/刷新统一视图（方案 §3.1）：
 * 热表 signals ∪ 冷归档 read_parquet('archive/**​/*.parquet', hive_partitioning=true)。
 * 尚无归档文件时退化为仅热表（read_parquet 对空 glob 会报错）。
 */
export async function ensureUnifiedView(conn: DuckDBConnection, archiveDir: string): Promise<void> {
  const parquetGlob = `${toGlobPath(archiveDir)}/**/*.parquet`;
  const hasArchive = containsParquet(archiveDir);
  const sql = hasArchive
    ? `CREATE OR REPLACE VIEW unified AS
         SELECT ts, channel_id, value FROM signals
         UNION ALL
         SELECT ts, channel_id, value FROM read_parquet('${parquetGlob}', hive_partitioning = true)`
    : `CREATE OR REPLACE VIEW unified AS SELECT ts, channel_id, value FROM signals`;
  await conn.run(sql);
}

function containsParquet(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(cur, entry.name));
      else if (entry.name.endsWith('.parquet')) return true;
    }
  }
  return false;
}

/** DuckDB glob 中使用 POSIX 风格路径分隔符，Windows 下需转换 */
function toGlobPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "''");
}
