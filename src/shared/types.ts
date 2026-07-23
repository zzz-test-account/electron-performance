/**
 * 三端共享的领域类型定义。
 * 设计原则（对应方案文档 §3.2）：主表"窄而长"建模，ts 用毫秒整型、channel 字典化、value DOUBLE。
 */

/** 预聚合金字塔层级：L0 原始 / L1 分钟级 / L2 秒级以上的大跨度聚合（见 schema.ts） */
export type SignalLayer = 'L0' | 'L1' | 'L2';

/** 毫秒时间戳闭区间 */
export interface TimeRange {
  start: number;
  end: number;
}

/** 信号明细行（signals 表 / L0 层） */
export interface SignalRow {
  ts: number;
  channelId: number;
  value: number;
}

/** 通道元信息（channel 字典表，字符串维度字典化为小整数，节省存储与扫描成本） */
export interface ChannelMeta {
  id: number;
  name: string;
}

/** 库级别概览（小状态，可直接走 JSON，无需 Arrow） */
export interface OverviewInfo {
  totalRows: number;
  minTs: number | null;
  maxTs: number | null;
  channels: ChannelMeta[];
}

/** 箱线图五数概括 + 样本数（SQL 层 approx_quantile 聚合产出，每箱仅 6 个标量） */
export interface BoxStats {
  /** 分组键：channelId 或时间桶起点（毫秒） */
  groupKey: number;
  low: number;
  q1: number;
  median: number;
  q3: number;
  high: number;
  count: number;
}

/** 直方图单个桶 */
export interface HistogramBin {
  binStart: number;
  binEnd: number;
  count: number;
}

/**
 * 渲染端发起查询的操作类型。
 * 刻意不暴露裸 SQL：所有 SQL 在数据服务进程内集中生成（query/*.ts），
 * 既保证参数化（防注入/命中 prepared 缓存），也让渲染端与存储 schema 解耦。
 */
export type QueryOp =
  | 'signal.range' // 视口曲线取数：{ channelId, start, end, layer } → Arrow 列块 [ts, value]
  | 'signal.page' // keyset 分页明细：{ channelId?, cursor?, limit } → Arrow 列块 [ts, channelId, value]
  | 'stats.boxplot' // 箱线五数：{ channelId?, start, end, bucketMs? } → Arrow 列块
  | 'stats.outliers' // 箱线异常点：{ channelId, start, end, maxPoints } → Arrow 列块 [ts, value]
  | 'stats.histogram' // 直方图：{ channelId, start, end, bins } → Arrow 列块
  | 'meta.overview'; // 库概览 → JSON（不走 Arrow）
