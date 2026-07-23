<script setup lang="ts">
/**
 * 海量曲线组件：视口感知的数据供给管线（方案 §5.1）。
 *
 * 管线：dataZoom/视口变化（150ms 去抖）→ 按跨度选预聚合层（L0/L1/L2）→
 * 数据服务 SQL 下推取数 → Worker MinMax+LTTB 精降至"像素×2"→ ECharts。
 * 总纲：任何时刻交给 ECharts 的点数 ≤ 屏幕横向像素的两倍——
 * 超过此数的点必然在物理像素上重叠，只贡献内存与耗时，不贡献视觉信息。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { echarts } from '../echartsSetup';
import { useAppStore } from '../stores/appStore';
import { dataClient } from '../sdk/dataClient';
import { realtimeHub } from '../sdk/realtimeHub';
import { downsample } from '../workers/downsampleService';
import { debounce } from '../utils/debounce';
import type { SignalLayer } from '../../../shared/types';

const DAY_MS = 86_400_000;

const store = useAppStore();
const container = ref<HTMLDivElement>();
// shallowRef：ECharts 实例是大型第三方对象，深度代理化是纯浪费（方案 §5.4）
const chart = shallowRef<ECharts>();
const loading = ref(false);
const pipelineInfo = ref('');

/** 视口感知选层：跨度大查聚合层、跨度小穿透 L0 原始层（方案 §5.1 金字塔） */
function pickLayer(spanMs: number): SignalLayer {
  if (spanMs > 14 * DAY_MS) return 'L2'; // 小时桶
  if (spanMs > 2 * DAY_MS) return 'L1'; // 分钟桶
  return 'L0';
}

/** 防止程序化 setOption 重置 dataZoom 再次触发加载的循环标志 */
let applyingZoom = false;

async function load(): Promise<void> {
  const c = chart.value;
  if (!c) return;
  loading.value = true;
  try {
    const layer = pickLayer(store.span);
    const res = await dataClient.signalRange(
      store.selectedChannelId,
      store.range,
      layer,
      'signal-chart', // 查询槽位：拖动缩放期间新查询自动取消旧查询（方案 §4.4）
    );
    const ts = res.columns.get('ts') as Float64Array | undefined;
    const value = res.columns.get('value') as Float64Array | undefined;
    if (!ts || !value || res.rowCount === 0) {
      applyingZoom = true;
      toRaw(c).setOption(buildOption([]), { lazyUpdate: true });
      applyingZoom = false;
      pipelineInfo.value = '视口内无数据';
      return;
    }

    // 最后一公里降采样在 Worker 中执行（主线程零阻塞），阈值 = 容器像素宽 × 2
    const pixelWidth = container.value?.clientWidth ?? 800;
    const target = Math.max(200, pixelWidth * 2);
    const { sx, sy } = await downsample(ts, value, target);

    // 降采样后 ≤ 数千点，组装 pair 的开销可忽略
    const pairs: [number, number][] = new Array(sx.length);
    for (let i = 0; i < sx.length; i++) pairs[i] = [sx[i], sy[i]];

    // setOption 直接操作 toRaw 实例，绕过 Vue 响应式 diff（方案 §5.4）
    applyingZoom = true;
    toRaw(c).setOption(buildOption(pairs), { lazyUpdate: true });
    applyingZoom = false;
    pipelineInfo.value = `${res.rowCount.toLocaleString()} 行 → ${pairs.length.toLocaleString()} 点 · ${layer} 层 · SQL ${res.elapsedMs.toFixed(0)}ms`;
  } catch (err) {
    // 被取消是正常交互路径（连续缩放），静默吞掉
    if (!(err as { cancelled?: boolean }).cancelled) {
      console.error('[SignalChart] 加载失败：', err);
      pipelineInfo.value = `加载失败：${(err as Error).message}`;
    }
  } finally {
    loading.value = false;
  }
}

const debouncedLoad = debounce(load, 150);

function buildOption(pairs: [number, number][]): EChartsCoreOption {
  return {
    animation: false, // 大数据场景关闭动画（方案 §8.3）
    grid: { left: 56, right: 16, top: 8, bottom: 48 },
    xAxis: { type: 'time', min: store.range.start, max: store.range.end },
    yAxis: { type: 'value', scale: true },
    dataZoom: [
      { type: 'inside', throttle: 150, start: 0, end: 100 },
      { type: 'slider', throttle: 150, start: 0, end: 100, height: 20 },
    ],
    series: [
      {
        type: 'line',
        showSymbol: false,
        sampling: 'lttb', // 内置 LTTB 兜底（Worker 未降采样时的双保险）
        large: true, // 大数据优化模式：关闭 symbol 与部分交互换吞吐
        progressive: 4000, // 分批渲染避免长帧
        data: pairs,
      },
    ],
  };
}

/** ResizeObserver 引用提升到 setup 作用域，供卸载钩子使用 */
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const c = echarts.init(container.value!);
  chart.value = c;

  // dataZoom 交互 → 视口子区间换算 → 写回 store（触发管线重新取数）
  c.on('datazoom', () => {
    if (applyingZoom) return;
    const opt = c.getOption() as { dataZoom?: { start?: number; end?: number }[] };
    const dz = opt.dataZoom?.[0];
    if (!dz || dz.start == null || dz.end == null) return;
    const { start, end } = store.range;
    const span = end - start;
    const subStart = Math.round(start + (dz.start / 100) * span);
    const subEnd = Math.round(start + (dz.end / 100) * span);
    if (subEnd - subStart < 1000) return; // 最小视口 1s，防无限下钻
    store.setRange({ start: subStart, end: subEnd });
  });

  // 容器尺寸变化（窗口缩放）→ 像素预算变化 → 重新降采样
  resizeObserver = new ResizeObserver(debouncedLoad);
  resizeObserver.observe(container.value!);

  watch(
    () => [store.selectedChannelId, store.range.start, store.range.end],
    () => debouncedLoad(),
    { immediate: true },
  );

  // 实时跟随：微批提交通知 → 视口滑动到最新（拉模式，方案 §6 订阅通道）
  realtimeHub.onIngest = (msg) => {
    if (store.followLive) store.slideToNow(msg.maxTs);
  };
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  // 图表实例随组件销毁显式 dispose 并断开数据引用（方案 §7 内存纪律）
  chart.value?.dispose();
  chart.value = undefined;
});
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <span class="panel-title">信号曲线 · CH-{{ store.selectedChannelId }}</span>
      <span class="panel-info">{{ pipelineInfo }}</span>
      <span v-if="loading" class="panel-loading">加载中…</span>
    </header>
    <div ref="container" class="chart"></div>
  </section>
</template>

<style scoped>
.chart {
  height: 340px;
  width: 100%;
}
</style>
