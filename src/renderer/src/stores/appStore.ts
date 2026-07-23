import { defineStore } from 'pinia';
import type { ChannelMeta, OverviewInfo, TimeRange } from '../../../shared/types';
import type { MetricsTickMsg } from '../../../shared/protocol';

/**
 * 应用状态（方案 §5.4 Vue3 响应式纪律）：
 * Pinia store 只放筛选条件、分页游标、聚合摘要这类小状态；
 * 大数据载荷（曲线点列、窗口行集）一律放组件内 shallowRef 或模块级变量，
 * 杜绝深度代理十万级对象。
 */
export const useAppStore = defineStore('app', {
  state: () => ({
    /** 库概览（通道列表、时间范围、总行数） */
    overview: null as OverviewInfo | null,
    /** 当前选中通道 */
    selectedChannelId: 0,
    /** 曲线/箱线联动的时间视口（毫秒纪元） */
    range: { start: Date.now() - 3_600_000, end: Date.now() } as TimeRange,
    /** 是否跟随最新数据（实时滚动模式） */
    followLive: true,
    /** 数据进程每秒指标（速率/水位/内存） */
    metrics: null as MetricsTickMsg | null,
    /** 模拟数据源运行状态（UI 显示用） */
    simRunning: true,
    simRate: 10_000,
  }),
  getters: {
    channels(): ChannelMeta[] {
      return this.overview?.channels ?? [];
    },
    /** 当前视口跨度（ms） */
    span(): number {
      return this.range.end - this.range.start;
    },
  },
  actions: {
    setRange(range: TimeRange): void {
      this.followLive = false;
      this.range = { ...range };
    },
    /** 保持跨度不变，把视口滑到最新（实时模式） */
    slideToNow(maxTs?: number): void {
      const end = maxTs ?? Date.now();
      this.range = { start: end - this.span, end };
    },
    setFollowLive(follow: boolean): void {
      this.followLive = follow;
      if (follow) this.slideToNow(this.overview?.maxTs ?? undefined);
    },
  },
});
