/// <reference lib="webworker" />
/**
 * 降采样 Worker（方案 §8.2 TypedArray 版，输入/输出均走 Transferable 零拷贝）。
 *
 * 算法：MinMax 预选 → LTTB 精降（MinMaxLTTB）。
 * - 数据量极大时先用 MinMax 预选把 LTTB 输入压缩一个量级（比纯 LTTB 快一个数量级以上，
 *   视觉代表性基本无损）；
 * - LTTB（Largest-Triangle-Three-Buckets）O(n) 保形降采样，能保住峰谷形态，
 *   是 Uber M3、TimescaleDB 等生产系统采用的同一算法。
 *
 * 注意：Worker 内不引入任何三方依赖，保持加载轻量、可独立运行。
 */

interface DownsampleRequest {
  kind: 'downsample';
  id: number;
  x: Float64Array;
  y: Float64Array;
  threshold: number;
}

interface DownsampleResponse {
  kind: 'downsample';
  id: number;
  sx: Float64Array;
  sy: Float64Array;
}

/** MinMax 预选：每桶保留 min/max 两点，把 n 压到 ~2*targetBuckets */
function minMaxPreselect(
  x: Float64Array,
  y: Float64Array,
  targetBuckets: number,
): [Float64Array, Float64Array] {
  const n = x.length;
  if (n <= targetBuckets * 2) return [x, y];
  const out = new Float64Array(targetBuckets * 2 * 2);
  const outX = new Float64Array(targetBuckets * 2 * 2);
  const bucketSize = n / targetBuckets;
  let w = 0;
  for (let b = 0; b < targetBuckets; b++) {
    const from = Math.floor(b * bucketSize);
    const to = Math.min(Math.floor((b + 1) * bucketSize), n);
    let minIdx = from;
    let maxIdx = from;
    for (let i = from; i < to; i++) {
      if (y[i] < y[minIdx]) minIdx = i;
      if (y[i] > y[maxIdx]) maxIdx = i;
    }
    // 保持时间先后顺序，避免折线回折
    if (minIdx <= maxIdx) {
      outX[w] = x[minIdx]; out[w++] = y[minIdx];
      outX[w] = x[maxIdx]; out[w++] = y[maxIdx];
    } else {
      outX[w] = x[maxIdx]; out[w++] = y[maxIdx];
      outX[w] = x[minIdx]; out[w++] = y[minIdx];
    }
  }
  return [outX.subarray(0, w) as Float64Array, out.subarray(0, w) as Float64Array];
}

/** LTTB：三桶最大三角形面积选点，O(n) */
function lttb(x: Float64Array, y: Float64Array, threshold: number): [Float64Array, Float64Array] {
  const n = x.length;
  if (threshold >= n || threshold < 3) return [x, y];
  const sx = new Float64Array(threshold);
  const sy = new Float64Array(threshold);
  sx[0] = x[0];
  sy[0] = y[0];
  const bucket = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // 下一桶平均点 C
    const c0 = Math.floor((i + 1) * bucket) + 1;
    const c1 = Math.min(Math.floor((i + 2) * bucket) + 1, n);
    let ax = 0;
    let ay = 0;
    for (let j = c0; j < c1; j++) {
      ax += x[j];
      ay += y[j];
    }
    ax /= c1 - c0;
    ay /= c1 - c0;
    // 当前桶内找与 A、C 构成最大三角形面积的点 B
    const b0 = Math.floor(i * bucket) + 1;
    const b1 = Math.min(Math.floor((i + 1) * bucket) + 1, n);
    let maxArea = -1;
    let idx = b0;
    for (let j = b0; j < b1; j++) {
      const area = Math.abs((x[a] - ax) * (y[j] - y[a]) - (x[a] - x[j]) * (ay - y[a]));
      if (area > maxArea) {
        maxArea = area;
        idx = j;
      }
    }
    sx[i + 1] = x[idx];
    sy[i + 1] = y[idx];
    a = idx;
  }
  sx[threshold - 1] = x[n - 1];
  sy[threshold - 1] = y[n - 1];
  return [sx, sy];
}

self.onmessage = (e: MessageEvent<DownsampleRequest>) => {
  const { id, x, y, threshold } = e.data;
  // 输入超过阈值 8 倍时先 MinMax 预选（压缩 LTTB 输入规模）
  const [px, py] = x.length > threshold * 8 ? minMaxPreselect(x, y, threshold * 4) : [x, y];
  const [sx, sy] = lttb(px, py, threshold);
  const response: DownsampleResponse = { kind: 'downsample', id, sx, sy };
  // Transferable 回传：O(1) 指针交换，不发生结构化克隆拷贝（方案 §4.3/§6）
  (self as unknown as Worker).postMessage(response, [sx.buffer, sy.buffer]);
};

export {};
