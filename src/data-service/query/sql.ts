import type { QueryOp, SignalLayer } from '../../shared/types';

/**
 * SQL 集中构建（方案 §4.1：SQL 下推优先）。
 *
 * 渲染端只发结构化操作（QueryOp），所有 SQL 在此生成并参数化——
 * 既防止注入，也让 DuckDB 的 prepared 缓存能命中同形语句。
 * 所有统计（箱线五数/直方图/异常点）都在引擎侧完成，只回传聚合标量。
 */

export interface BuiltQuery {
  sql: string;
  params: (number | bigint | string | null)[];
}

/** 单查询软上限：防止渲染端误配导致全量物化（方案 §7：禁止无上限 fetchAll） */
const ROW_GUARD = 5_000_000;

export function buildQuery(op: QueryOp, p: Record<string, unknown>): BuiltQuery {
  switch (op) {
    case 'signal.range': {
      const layer = p.layer as SignalLayer;
      // L0 穿透统一视图（热 + 冷归档）；L1/L2 走预聚合表（方案 §5.1 视口感知选层）
      const table = layer === 'L0' ? 'unified' : layer === 'L1' ? 'signals_l1' : 'signals_l2';
      const valueCol = layer === 'L0' ? 'value' : 'avg_v';
      return {
        sql: `SELECT ts, ${valueCol} AS value FROM ${table}
              WHERE channel_id = $1 AND ts BETWEEN $2 AND $3
              ORDER BY ts LIMIT ${ROW_GUARD}`,
        params: [num(p.channelId), num(p.start), num(p.end)],
      };
    }

    case 'signal.page': {
      // keyset（游标）分页：WHERE ts < cursor 借助 ts 有序性与 zonemap 近恒定耗时，
      // 避免深 OFFSET 的全量扫描跳过（方案 §5.3）
      return {
        sql: `SELECT ts, channel_id, value FROM unified
              WHERE ($1::INTEGER IS NULL OR channel_id = $1)
                AND ($2::BIGINT IS NULL OR ts < $2)
              ORDER BY ts DESC LIMIT $3`,
        params: [nullableNum(p.channelId), nullableNum(p.cursor), num(p.limit)],
      };
    }

    case 'stats.boxplot': {
      // 箱线五数在 SQL 层聚合，每箱仅回传 7 个标量（方案 §4.2）；
      // 展示用 approx_quantile（单次扫描近似，误差肉眼不可辨）
      const bucketMs = nullableNum(p.bucketMs);
      const channelFilter = '($3::INTEGER IS NULL OR channel_id = $3)';
      if (bucketMs != null) {
        // 按时间桶的箱线序列：一条 SQL 产出全部箱体，传输量从千万行压缩到每桶一行
        return {
          sql: `SELECT (ts // $4) * $4 AS gk,
                       min(value) AS low, approx_quantile(value, 0.25) AS q1,
                       approx_quantile(value, 0.5) AS median, approx_quantile(value, 0.75) AS q3,
                       max(value) AS high, count(*) AS n
                FROM unified
                WHERE ts BETWEEN $1 AND $2 AND ${channelFilter}
                GROUP BY 1 ORDER BY 1`,
          params: [num(p.start), num(p.end), nullableNum(p.channelId), bucketMs],
        };
      }
      return {
        sql: `SELECT channel_id AS gk,
                     min(value) AS low, approx_quantile(value, 0.25) AS q1,
                     approx_quantile(value, 0.5) AS median, approx_quantile(value, 0.75) AS q3,
                     max(value) AS high, count(*) AS n
              FROM unified
              WHERE ts BETWEEN $1 AND $2 AND ${channelFilter}
              GROUP BY channel_id ORDER BY channel_id`,
        params: [num(p.start), num(p.end), nullableNum(p.channelId)],
      };
    }

    case 'stats.outliers': {
      // 1.5×IQR 越界点二次查询：仅取 (ts, value)，数量天然稀少，并设上限防极端分布膨胀（方案 §4.2/§5.2）
      return {
        sql: `WITH s AS (
                SELECT approx_quantile(value, 0.25) AS q1, approx_quantile(value, 0.75) AS q3
                FROM unified
                WHERE ts BETWEEN $1 AND $2 AND channel_id = $3
              )
              SELECT u.ts, u.value FROM unified u, s
              WHERE u.ts BETWEEN $1 AND $2 AND u.channel_id = $3
                AND (u.value < s.q1 - 1.5 * (s.q3 - s.q1) OR u.value > s.q3 + 1.5 * (s.q3 - s.q1))
              ORDER BY u.ts LIMIT $4`,
        params: [num(p.start), num(p.end), num(p.channelId), num(p.maxPoints)],
      };
    }

    case 'stats.histogram': {
      // 等宽直方图下推：桶内 count(*) 聚合，bin 起点/宽度随结果回传供渲染端换算
      return {
        sql: `WITH b AS (SELECT min(value) AS lo, max(value) AS hi
                         FROM unified WHERE channel_id = $1 AND ts BETWEEN $2 AND $3)
              SELECT least(CAST(floor((u.value - b.lo) / nullif((b.hi - b.lo) / $4, 0)) AS INTEGER), $4 - 1) AS bin,
                     count(*) AS n, min(b.lo) AS lo, max(b.hi) AS hi
              FROM unified u, b
              WHERE u.channel_id = $1 AND u.ts BETWEEN $2 AND $3
              GROUP BY 1 ORDER BY 1`,
        params: [num(p.channelId), num(p.start), num(p.end), num(p.bins)],
      };
    }

    default:
      throw new Error(`未知查询操作：${op}`);
  }
}

function num(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`参数缺失或非法：${String(v)}`);
  return v;
}

function nullableNum(v: unknown): number | null {
  return v == null ? null : num(v);
}
