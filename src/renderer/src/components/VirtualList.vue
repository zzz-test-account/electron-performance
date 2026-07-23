<script setup lang="ts">
/**
 * 通用虚拟列表（零依赖，固定行高场景，方案 §5.3）。
 *
 * 只渲染可视区及前后缓冲行：DOM 节点恒定在几十个，与数据总量无关——
 * 千行场景的 DOM 从 1000 降至约 20，滚动帧率回到 60fps。
 *
 * 为什么自研而不引库：固定行高的虚拟列表逻辑极薄（可视区间换算 + 绝对定位），
 * 自研零依赖可避免 UMD 老库在 Vue3 + Vite 下的兼容问题；若未来需要动态行高，
 * 再整体替换为 @tanstack/vue-virtual（方案 §5.3 选型建议），组件接口保持不变。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 全量数据（只切片渲染，不做任何深拷贝） */
    items: unknown[];
    /** 固定行高（px） */
    rowHeight: number;
    /** 可视区外上下各多渲染的缓冲行数 */
    buffer?: number;
  }>(),
  { buffer: 8 },
);

const emit = defineEmits<{ scroll: [e: Event] }>();

const container = ref<HTMLDivElement>();
const scrollTop = ref(0);
const viewHeight = ref(0);

/** 可视区间（含缓冲）对应的行下标范围 */
const range = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - props.buffer);
  const end = Math.min(
    props.items.length,
    Math.ceil((scrollTop.value + viewHeight.value) / props.rowHeight) + props.buffer,
  );
  return { start, end };
});

/** 可视切片：带原始下标，供 key 与插槽使用 */
const visible = computed(() => {
  const { start, end } = range.value;
  const out: { item: unknown; index: number }[] = [];
  for (let i = start; i < end; i++) out.push({ item: props.items[i], index: i });
  return out;
});

function onScroll(e: Event): void {
  scrollTop.value = (e.target as HTMLElement).scrollTop;
  emit('scroll', e); // 透传给父组件做"接近底部加载下一页"判定
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  viewHeight.value = container.value!.clientHeight;
  observer = new ResizeObserver(() => {
    viewHeight.value = container.value!.clientHeight;
  });
  observer.observe(container.value!);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="container" class="vl-container" @scroll="onScroll">
    <!-- 幻影层：撑出完整滚动高度 -->
    <div class="vl-phantom" :style="{ height: `${items.length * rowHeight}px` }">
      <!-- 内容层：平移到可视区间起点，只渲染切片 -->
      <div class="vl-content" :style="{ transform: `translateY(${range.start * rowHeight}px)` }">
        <div
          v-for="entry in visible"
          :key="entry.index"
          class="vl-row"
          :style="{ height: `${rowHeight}px` }"
        >
          <slot :item="entry.item" :index="entry.index" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vl-container {
  height: 100%;
  overflow-y: auto;
  position: relative;
}
.vl-phantom {
  position: relative;
}
.vl-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}
</style>
