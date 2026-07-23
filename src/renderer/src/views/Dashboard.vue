<script setup lang="ts">
/**
 * 总装视图：运行指标条 + 控制条 + 三大组件（曲线 / 箱线 / 明细表）。
 *
 * 数据来源：
 * - 订阅通道 tick → 写入速率 / 队列水位 / 数据进程内存（内存治理可视化，方案 §7）；
 * - meta.overview → 通道列表与全库时间范围（初始化与快捷视口）；
 * - 写入通道 → 模拟数据源开关与调速。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useAppStore } from '../stores/appStore';
import { dataClient } from '../sdk/dataClient';
import { realtimeHub } from '../sdk/realtimeHub';
import { onDataServiceRestarted } from '../sdk/portBridge';
import SignalChart from '../components/SignalChart.vue';
import BoxplotPanel from '../components/BoxplotPanel.vue';
import VirtualTable from '../components/VirtualTable.vue';

const store = useAppStore();
const restarting = ref(false);

const QUICK_RANGES = [
  { label: '5 分钟', span: 5 * 60_000 },
  { label: '1 小时', span: 3_600_000 },
  { label: '1 天', span: 86_400_000 },
  { label: '7 天', span: 7 * 86_400_000 },
] as const;

function setQuickRange(span: number): void {
  const end = store.overview?.maxTs ?? Date.now();
  store.setRange({ start: end - span, end });
}

function setFullRange(): void {
  const o = store.overview;
  if (!o || o.minTs == null || o.maxTs == null) return;
  store.setRange({ start: o.minTs, end: o.maxTs });
}

function toggleSim(): void {
  store.simRunning = !store.simRunning;
  realtimeHub.simControl({ running: store.simRunning });
}

function onRateChange(e: Event): void {
  const rate = Number((e.target as HTMLInputElement).value);
  store.simRate = rate;
  realtimeHub.simControl({ rate });
}

async function bootstrap(): Promise<void> {
  await Promise.all([dataClient.init(), realtimeHub.init()]);
  realtimeHub.onTick = (msg) => {
    store.metrics = msg;
  };
  const overview = await dataClient.overview();
  store.overview = overview;
  if (store.followLive) store.slideToNow(overview.maxTs ?? undefined);
  restarting.value = false;
}

onMounted(() => {
  void bootstrap();
  // 数据进程重启（崩溃/内存重生）→ 重新建连、重新拉概览（方案 §7 自动重生策略的渲染端配合）
  onDataServiceRestarted(() => {
    restarting.value = true;
    dataClient.reset();
    realtimeHub.reset();
    void bootstrap();
  });
});

onBeforeUnmount(() => {
  realtimeHub.onTick = null;
  realtimeHub.onIngest = null;
});
</script>

<template>
  <div class="dashboard">
    <header class="topbar">
      <span class="title">Electron 大数据存储与高性能计算 · 验证工程</span>
      <span v-if="restarting" class="badge badge-warn">数据进程重启中…</span>
      <template v-if="store.metrics">
        <span class="badge">写入 {{ store.metrics.rowsPerSec.toLocaleString() }} 行/s</span>
        <span class="badge">累计 {{ store.metrics.writtenTotal.toLocaleString() }} 行</span>
        <span class="badge" :class="{ 'badge-warn': store.metrics.queueLevel > 0.5 }">
          队列水位 {{ (store.metrics.queueLevel * 100).toFixed(1) }}%
        </span>
        <span class="badge">DS rss {{ store.metrics.rssMb }}MB</span>
        <span class="badge" :class="{ 'badge-warn': store.metrics.arrayBuffersMb > 256 }">
          堆外 {{ store.metrics.arrayBuffersMb.toFixed(1) }}MB
        </span>
      </template>
    </header>

    <div class="controls">
      <label>
        通道
        <select v-model.number="store.selectedChannelId">
          <option v-for="ch in store.channels" :key="ch.id" :value="ch.id">{{ ch.name }}</option>
        </select>
      </label>
      <label class="follow">
        <input type="checkbox" :checked="store.followLive" @change="store.setFollowLive(($event.target as HTMLInputElement).checked)" />
        实时跟随
      </label>
      <button v-for="r in QUICK_RANGES" :key="r.label" @click="setQuickRange(r.span)">最近{{ r.label }}</button>
      <button @click="setFullRange">全部范围</button>
      <span class="spacer"></span>
      <button @click="toggleSim">{{ store.simRunning ? '停止模拟源' : '启动模拟源' }}</button>
      <label>
        速率 {{ store.simRate.toLocaleString() }} 行/s
        <input type="range" min="1000" max="50000" step="1000" :value="store.simRate" @change="onRateChange" />
      </label>
      <span v-if="store.overview" class="overview-info">
        库内 {{ store.overview.totalRows.toLocaleString() }} 行
      </span>
    </div>

    <main class="grid">
      <SignalChart />
      <BoxplotPanel />
      <VirtualTable />
    </main>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 0 16px 16px;
  box-sizing: border-box;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 48px;
}
.title {
  font-weight: 600;
  margin-right: 12px;
}
.badge {
  background: #f2f5f9;
  border: 1px solid var(--control-border);
  border-radius: 10px;
  padding: 2px 10px;
  font-size: 12px;
  color: #5b6b7d;
  font-variant-numeric: tabular-nums;
}
.badge-warn {
  color: var(--warn);
  border-color: var(--warn-border);
}
.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  font-size: 13px;
  color: #5b6b7d;
  flex-wrap: wrap;
}
.controls select,
.controls button {
  background: var(--control-bg);
  color: var(--text);
  border: 1px solid var(--control-border);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.controls button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.spacer {
  flex: 1;
}
.overview-info {
  font-variant-numeric: tabular-nums;
}
.grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}
</style>
