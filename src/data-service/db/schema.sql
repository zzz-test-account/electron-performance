-- 数据服务建库脚本（src/data-service/db/schema.ts 与 scripts/seed.mjs 共用，单一事实来源）
-- 建模原则（方案 §3.2）：主表"窄而长"，ts 用 BIGINT 毫秒戳、channel 字典化为 INTEGER、value DOUBLE；
-- 数据按 ts 有序写入，让 zonemap（row group 级 min/max 统计）自动剪枝范围过滤。

CREATE TABLE IF NOT EXISTS channels (
  id   INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL
);

-- L0：原始信号（热表；归档时按 dt 分区导出 Parquet 后删除旧区间）
CREATE TABLE IF NOT EXISTS signals (
  ts         BIGINT NOT NULL,
  channel_id INTEGER NOT NULL,
  value      DOUBLE NOT NULL
);

-- L1：分钟级预聚合（视口跨度大时的曲线数据源，方案 §5.1 预聚合金字塔）
CREATE TABLE IF NOT EXISTS signals_l1 (
  ts         BIGINT NOT NULL,  -- 分钟桶起点（epoch ms）
  channel_id INTEGER NOT NULL,
  avg_v      DOUBLE,
  min_v      DOUBLE,
  max_v      DOUBLE,
  n          BIGINT,
  PRIMARY KEY (ts, channel_id)
);

-- L2：小时级预聚合（超大跨度，如数月一览）
CREATE TABLE IF NOT EXISTS signals_l2 (
  ts         BIGINT NOT NULL,  -- 小时桶起点（epoch ms）
  channel_id INTEGER NOT NULL,
  avg_v      DOUBLE,
  min_v      DOUBLE,
  max_v      DOUBLE,
  n          BIGINT,
  PRIMARY KEY (ts, channel_id)
);
