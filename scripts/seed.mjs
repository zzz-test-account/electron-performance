/**
 * 历史数据灌注脚本（独立 Node 进程运行，不经 Electron）：
 *   npm run seed                # 默认 30 天 × 4 通道 × 1 行/秒 ≈ 1037 万行
 *   SEED_DAYS=7 npm run seed    # 自定义天数
 *   SEED_FORCE=1 npm run seed   # 清空 signals 后重灌
 *
 * 用途：验收"千万行数据全链路可用"——曲线任意跨度首屏、箱线统计、
 * 虚拟列表滚动、以及首次启动时的 Parquet 归档管线（早于保留窗口的数据
 * 会在数据服务启动 15s 后自动归档，见 data-service/index.ts）。
 *
 * 与数据服务进程共用同一份 schema.sql 与同一个数据目录（默认 ./data），
 * 写入走 Appender 批量直写（方案 §3.3：禁止逐行 INSERT）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DAYS = Number(process.env.SEED_DAYS ?? 30);
const CHANNELS = Number(process.env.SEED_CHANNELS ?? 4);
const ROWS_PER_SEC_PER_CHANNEL = 1;
const BATCH_ROWS = 500_000;

const schemaSql = fs.readFileSync(path.join(ROOT, 'src/data-service/db/schema.sql'), 'utf-8');

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sample(channel, ts) {
  const periodMs = 60_000 + channel * 30_000;
  const phase = channel * 1.3;
  const base = 50 + channel * 10;
  const sine = 30 * Math.sin((2 * Math.PI * ts) / periodMs + phase);
  const spike = Math.random() < 0.002 ? (Math.random() - 0.5) * 120 : 0;
  return base + sine + gaussian() * 2 + spike;
}

async function main() {
  const hotDir = path.join(DATA_DIR, 'hot');
  fs.mkdirSync(hotDir, { recursive: true });
  const dbPath = path.join(hotDir, 'hot.duckdb');
  console.log(`[seed] 数据库：${dbPath}`);

  const instance = await DuckDBInstance.create(dbPath, { memory_limit: '1GB' });
  const conn = await instance.connect();

  for (const stmt of schemaSql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await conn.run(stmt);
  }
  for (let i = 0; i < CHANNELS; i++) {
    await conn.run('INSERT OR IGNORE INTO channels VALUES ($1, $2)', [i, `CH-${i}`]);
  }

  const existing = Number(
    (await (await conn.run('SELECT count(*) AS n FROM signals')).getRowObjects())[0].n,
  );
  if (existing > 0) {
    if (process.env.SEED_FORCE === '1') {
      console.log(`[seed] 清空已有 ${existing.toLocaleString()} 行…`);
      await conn.run('DELETE FROM signals');
    } else {
      console.log(`[seed] signals 已有 ${existing.toLocaleString()} 行，跳过（SEED_FORCE=1 可重灌）`);
      conn.closeSync();
      instance.closeSync();
      return;
    }
  }

  const end = Date.now();
  const start = end - DAYS * 86_400_000;
  const totalRows = DAYS * 86_400 * CHANNELS * ROWS_PER_SEC_PER_CHANNEL;
  console.log(`[seed] 目标 ${totalRows.toLocaleString()} 行（${DAYS} 天 × ${CHANNELS} 通道）…`);

  const t0 = performance.now();
  let written = 0;
  // 按 ts 升序成批写入：有序数据让 zonemap 范围剪枝生效（方案 §3.2）
  while (written < totalRows) {
    const batchCount = Math.min(BATCH_ROWS, totalRows - written);
    const appender = await conn.createAppender('signals');
    for (let i = 0; i < batchCount; i++) {
      const seq = written + i; // 全局行序号 → ts / channel
      const perSec = CHANNELS * ROWS_PER_SEC_PER_CHANNEL;
      const ts = start + Math.floor(seq / perSec) * 1000;
      const channel = seq % CHANNELS;
      appender.appendBigInt(BigInt(ts));
      appender.appendInteger(channel);
      appender.appendDouble(sample(channel, ts));
      appender.endRow();
    }
    appender.closeSync();
    written += batchCount;
    const eps = (written / ((performance.now() - t0) / 1000)).toFixed(0);
    console.log(`[seed] ${written.toLocaleString()} / ${totalRows.toLocaleString()}（${Number(eps).toLocaleString()} 行/s）`);
  }

  // 预聚合金字塔全量构建（L1 分钟桶 / L2 小时桶，方案 §5.1）
  console.log('[seed] 构建 L1/L2 预聚合…');
  await conn.run(`DELETE FROM signals_l1`);
  await conn.run(
    `INSERT INTO signals_l1
       SELECT (ts // 60000) * 60000, channel_id, avg(value), min(value), max(value), count(*)
       FROM signals GROUP BY 1, 2`,
  );
  await conn.run(`DELETE FROM signals_l2`);
  await conn.run(
    `INSERT INTO signals_l2
       SELECT (ts // 3600000) * 3600000, channel_id, avg(value), min(value), max(value), count(*)
       FROM signals GROUP BY 1, 2`,
  );

  const seconds = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[seed] 完成：${written.toLocaleString()} 行，耗时 ${seconds}s`);
  conn.closeSync();
  instance.closeSync();
}

main().catch((err) => {
  console.error('[seed] 失败：', err);
  process.exit(1);
});
