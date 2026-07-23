<script setup lang="ts">
/**
 * 明细表行（固定行高 32px，配合 VirtualList 的固定行高假设）。
 */
import type { TableRowData } from './virtualTableTypes';

defineProps<{ row: TableRowData }>();

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

function fmt(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
</script>

<template>
  <div class="table-row">
    <span class="cell cell-ts">{{ fmt(row.ts) }}</span>
    <span class="cell cell-ch">CH-{{ row.channelId }}</span>
    <span class="cell cell-val">{{ row.value.toFixed(3) }}</span>
  </div>
</template>

<style scoped>
.table-row {
  display: flex;
  height: 32px;
  line-height: 32px;
  border-bottom: 1px solid #1e2a38;
  font-variant-numeric: tabular-nums;
}
.cell {
  padding: 0 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-ts {
  flex: 1;
  color: #9fb3c8;
}
.cell-ch {
  width: 80px;
  color: #4da3ff;
}
.cell-val {
  width: 120px;
  text-align: right;
}
</style>
