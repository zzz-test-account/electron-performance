/**
 * 明细表行的数据结构（VirtualTable 与 TableRow 共享，避免循环依赖）。
 */
export interface TableRowData {
  key: string;
  ts: number;
  channelId: number;
  value: number;
}
