<script setup lang="ts">
/**
 * 箱线图面板（方案 §4.2 / §5.2）。
 *
 * 纪律：五数概括（min/Q1/median/Q3/max）与异常值判定全部在 SQL 层完成，
 * 渲染层只拿每箱一行的聚合结果与少量越界散点——绝不在渲染进程用全量数据
 * 现场计算分位数（既慢又违背内存纪律）。
 *
 * 联动：框选（brush）若干箱体 → 换算为时间范围写回 store →
 * SignalChart 按 §5.1 管线穿透到更细的层展示该区间原始形态。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { echarts } from '../echartsSetup';
import { useAppStore } from '../stores/appStore';
import { dataClient } from '../sdk/dataClient';
import { debounce } from '../utils/debounce';

const store = useAppStore();
const container = ref<HTMLDivElement>();
const chart = shallowRef<ECharts>();
const loading = ref(false);
const statsInfo = ref('');

/** 当前视口下的时间桶（brush 联动换算依赖它，保持模块级一致） */
let currentBucketMs = 60_000;
/** SQL 返回的各桶绝对起点（epoch ms），与类目轴一一对应 */
let currentBucketStarts: number[] = [];

/** 把跨度切成约 40 桶，并对齐到"好看"的桶宽 */
function pickBucketMs(spanMs: number): number {
  const candidates = [
    1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000,
    21_600_000, 86_400_000,
  ];
  const target = spanMs / 40;
  for (const c of candidates) if (c >= target) return c;
  return 7 * 86_400_000;
}

const fmtTime = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function load(): Promise<void> {
  const c = chart.value;
  if (!c) return;
  loading.value = true;
  try {
    currentBucketMs = pickBucketMs(store.span);
    const [boxRes, outlierRes] = await Promise.all([
      dataClient.boxplotByBucket(store.selectedChannelId, store.range, currentBucketMs, 'boxplot'),
      // 异常点单独取（1.5×IQR 越界），每通道上限 500 防极端分布回传膨胀（方案 §5.2）
      dataClient.outliers(store.selectedChannelId, store.range, 500),
    ]);

    const gk = boxRes.columns.get('gk') as Float64Array;
    const low = boxRes.columns.get('low') as Float64Array;
    const q1 = boxRes.columns.get('q1') as Float64Array;
    const median = boxRes.columns.get('median') as Float64Array;
    const q3 = boxRes.columns.get('q3') as Float64Array;
    const high = boxRes.columns.get('high') as Float64Array;

    const categories: string[] = new Array(boxRes.rowCount);
    const boxData: number[][] = new Array(boxRes.rowCount);
    const bucketStartToIndex = new Map<number, number>();
    for (let i = 0; i < boxRes.rowCount; i++) {
      categories[i] = fmtTime(gk[i]);
      // ECharts boxplot 接受的正是五数数组 [low, Q1, median, Q3, high]，与 SQL 输出天然对齐
      boxData[i] = [low[i], q1[i], median[i], q3[i], high[i]];
      bucketStartToIndex.set(gk[i], i);
    }
    currentBucketStarts = Array.from(gk);

    // 异常散点：ts → 所属桶类目下标
    const ots = (outlierRes.columns.get('ts') as Float64Array) ?? new Float64Array(0);
    const oval = (outlierRes.columns.get('value') as Float64Array) ?? new Float64Array(0);
    const scatterData: [string, number][] = [];
    for (let i = 0; i < ots.length; i++) {
      const bucketStart = Math.floor(ots[i] / currentBucketMs) * currentBucketMs;
      const idx = bucketStartToIndex.get(bucketStart);
      if (idx != null) scatterData.push([categories[idx], oval[i]]);
    }

    toRaw(c).setOption(buildOption(categories, boxData, scatterData), {
      lazyUpdate: true,
      notMerge: true,
    });
    statsInfo.value = `${boxRes.rowCount} 箱 · 桶宽 ${currentBucketMs / 1000}s · 异常点 ${scatterData.length} · SQL ${boxRes.elapsedMs.toFixed(0)}ms`;
  } catch (err) {
    if (!(err as { cancelled?: boolean }).cancelled) {
      console.error('[BoxplotPanel] 加载失败：', err);
      statsInfo.value = `加载失败：${(err as Error).message}`;
    }
  } finally {
    loading.value = false;
  }
}

const debouncedLoad = debounce(load, 150);

function buildOption(
  categories: string[],
  boxData: number[][],
  scatterData: [string, number][],
): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 8, bottom: 56 },
    xAxis: { type: 'category', data: categories, axisLabel: { interval: Math.ceil(categories.length / 8) } },
    yAxis: { type: 'value', scale: true },
    brush: { toolbox: ['lineX', 'clear'], xAxisIndex: 0, throttle: 150 },
    toolbox: { feature: { brush: { type: ['lineX', 'clear'] } }, right: 8 },
    series: [
      { type: 'boxplot', data: boxData, itemStyle: { color: '#1f3b57', borderColor: '#4da3ff' } },
      { type: 'scatter', data: scatterData, symbolSize: 3, itemStyle: { color: '#ff6b6b' } },
    ],
  };
}

onMounted(() => {
  const c = echarts.init(container.value!);
  chart.value = c;

  // brush 框选箱体 → 类目区间换算回时间范围 → 联动 SignalChart（方案 §5.2）
  c.on('brushSelected', (e: unknown) => {
    const event = e as {
      batch?: { selected?: { dataIndex?: number[] }[] }[];
    };
    const indexes = event.batch?.[0]?.selected?.[0]?.dataIndex ?? [];
    if (indexes.length === 0) return;
    const minIdx = Math.min(...indexes);
    const maxIdx = Math.max(...indexes);
    // 类目下标 → 绝对时间范围（桶起点数组与类目轴一一对应）
    if (minIdx >= currentBucketStarts.length || maxIdx >= currentBucketStarts.length) return;
    store.setRange({
      start: currentBucketStarts[minIdx],
      end: currentBucketStarts[maxIdx] + currentBucketMs,
    });
    // 框选完成后清除刷选框，避免残留视觉干扰
    c.dispatchAction({ type: 'brush', areas: [] });
  });

  watch(
    () => [store.selectedChannelId, store.range.start, store.range.end],
    () => debouncedLoad(),
    { immediate: true },
  );
});

onBeforeUnmount(() => {
  chart.value?.dispose();
  chart.value = undefined;
});
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <span class="panel-title">箱线统计 · CH-{{ store.selectedChannelId }}（框选箱体可联动曲线下钻）</span>
      <span class="panel-info">{{ statsInfo }}</span>
      <span v-if="loading" class="panel-loading">加载中…</span>
    </header>
    <div ref="container" class="chart"></div>
  </section>
</template>

<style scoped>
.chart {
  height: 260px;
  width: 100%;
}
</style>
