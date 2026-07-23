<script setup lang="ts">
/**
 * 海量明细表格：虚拟列表 + keyset（游标）分页（方案 §5.3）。
 *
 * - 虚拟列表只渲染可视区及前后缓冲行，DOM 节点恒定在几十个；
 * - 滚动位置换算为 keyset 条件（WHERE ts < cursor ORDER BY ts DESC LIMIT 500），
 *   借助 ts 有序性与 zonemap 近恒定耗时，避免深 OFFSET 的全量扫描；
 * - 窗口数据放 shallowRef 整体替换（一次赋值一次触发），不做元素级响应式（方案 §5.4）。
 */
import { onMounted, ref, shallowRef, watch } from 'vue';
import { dataClient } from '../sdk/dataClient';
import VirtualList from './VirtualList.vue';
import TableRow from './TableRow.vue';
import type { TableRowData } from './virtualTableTypes';

const PAGE_SIZE = 500;
/** 内存中最多保留的页数（防长时间滚动导致窗口无限膨胀） */
const MAX_PAGES = 40;

/** shallowRef：行集整体替换，不做元素级深度代理 */
const rows = shallowRef<TableRowData[]>([]);
const loading = ref(false);
const hasMore = ref(true);
const totalLoaded = ref(0);
const channelFilter = ref<number | null>(null); // null = 全部通道

let cursor: number | null = null;
let loadingPage = false;

/** 滚动接近底部 → 拉下一页（虚拟列表根节点即滚动容器） */
function onScroll(e: Event): void {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) void loadMore();
}

async function loadMore(): Promise<void> {
  if (loadingPage || !hasMore.value) return;
  loadingPage = true;
  loading.value = true;
  try {
    const res = await dataClient.signalPage(channelFilter.value, cursor, PAGE_SIZE);
    const ts = res.columns.get('ts') as Float64Array;
    const ch = res.columns.get('channel_id') as Int32Array;
    const val = res.columns.get('value') as Float64Array;
    const page: TableRowData[] = new Array(res.rowCount);
    for (let i = 0; i < res.rowCount; i++) {
      page[i] = { key: `${ts[i]}-${ch[i]}`, ts: ts[i], channelId: ch[i], value: val[i] };
    }
    if (res.rowCount > 0) cursor = ts[res.rowCount - 1]; // DESC 序的最后一行即下一页游标
    hasMore.value = res.rowCount === PAGE_SIZE;

    // 整体替换触发一次更新；超出页数上限时从头部裁掉旧页（内存有硬顶）
    let next = rows.value.concat(page);
    if (next.length > MAX_PAGES * PAGE_SIZE) next = next.slice(next.length - MAX_PAGES * PAGE_SIZE);
    rows.value = next;
    totalLoaded.value += res.rowCount;
  } catch (err) {
    if (!(err as { cancelled?: boolean }).cancelled) {
      console.error('[VirtualTable] 加载失败：', err);
    }
  } finally {
    loadingPage = false;
    loading.value = false;
  }
}

function reset(): void {
  cursor = null;
  hasMore.value = true;
  totalLoaded.value = 0;
  rows.value = [];
  void loadMore();
}

watch(channelFilter, reset);

onMounted(reset);
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <span class="panel-title">明细浏览（虚拟列表 + keyset 分页）</span>
      <select
        class="channel-filter"
        :value="channelFilter === null ? 'all' : channelFilter"
        @change="channelFilter = ($event.target as HTMLSelectElement).value === 'all' ? null : Number(($event.target as HTMLSelectElement).value)"
      >
        <option value="all">全部通道</option>
        <option v-for="ch in [0, 1, 2, 3]" :key="ch" :value="ch">CH-{{ ch }}</option>
      </select>
      <span class="panel-info">
        已加载 {{ totalLoaded.toLocaleString() }} 行 · 内存窗口 {{ rows.length.toLocaleString() }} 行
        <template v-if="!hasMore"> · 已到底</template>
      </span>
      <span v-if="loading" class="panel-loading">加载中…</span>
    </header>
    <div class="table-head">
      <span class="cell cell-ts">时间戳</span>
      <span class="cell cell-ch">通道</span>
      <span class="cell cell-val">值</span>
    </div>
    <VirtualList
      class="virtual-list"
      :items="rows"
      :row-height="32"
      @scroll="onScroll"
      v-slot="{ item }"
    >
      <TableRow :row="item as TableRowData" />
    </VirtualList>
  </section>
</template>

<style scoped>
.virtual-list {
  height: 280px;
  overflow-y: auto;
}
.table-head {
  display: flex;
  height: 28px;
  line-height: 28px;
  font-size: 12px;
  color: #8a97a8;
  border-bottom: 1px solid var(--panel-border);
}
.cell {
  padding: 0 12px;
}
.cell-ts {
  flex: 1;
}
.cell-ch {
  width: 80px;
}
.cell-val {
  width: 120px;
  text-align: right;
}
.channel-filter {
  margin-left: 12px;
  background: var(--control-bg);
  color: var(--text);
  border: 1px solid var(--control-border);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}
</style>
