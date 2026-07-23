/**
 * 事件去抖（方案 §4.4）：交互式查询（缩放/平移/切换通道）统一经 150ms 去抖，
 * 把高频交互对数据服务进程的压力削掉一个数量级。
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs = 150,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}
