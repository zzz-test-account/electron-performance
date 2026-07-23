import { WorkerPool } from './workerPool';

/**
 * 降采样服务：Worker 池 + Transferable 的封装（渲染主线程只做发起与消费）。
 *
 * 输入的 x/y 会被转移到 Worker（转移后调用方持有的 buffer 失效），
 * 返回的 sx/sy 同样是转移回来的新 buffer——全链路零拷贝。
 */

interface DownsampleResult {
  sx: Float64Array;
  sy: Float64Array;
}

const pool = new WorkerPool(
  () => new Worker(new URL('./lttb.worker.ts', import.meta.url), { type: 'module' }),
);

/**
 * 把 (x, y) 序列降到 threshold 个点（MinMax 预选 + LTTB 精降）。
 * 注意：调用后 x/y 的底层 buffer 已被转移，不可再读。
 */
export async function downsample(
  x: Float64Array,
  y: Float64Array,
  threshold: number,
): Promise<DownsampleResult> {
  if (x.length <= threshold) return { sx: x, sy: y };
  const res = (await pool.exec({ kind: 'downsample', x, y, threshold }, [
    x.buffer,
    y.buffer,
  ])) as DownsampleResult & { kind: string };
  return { sx: res.sx, sy: res.sy };
}
