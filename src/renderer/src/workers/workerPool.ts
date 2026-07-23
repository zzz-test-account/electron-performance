/**
 * 常驻 Web Worker 池（方案 §4.3）。
 *
 * - 池大小取 hardwareConcurrency - 2，启动时一次性创建、任务队列复用，
 *   避免每任务新建线程的 30–50ms 级开销；
 * - 任务派发为 Promise 化 RPC（Comlink 风格的最小实现）；
 * - 大数据载荷一律 Transferable（1MB 以上拷贝与转移耗时差 20 倍以上）。
 */

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  pending: Map<number, PendingCall>;
}

export class WorkerPool {
  private workers: PooledWorker[] = [];
  private queue: { id: number; payload: unknown; transfer: Transferable[]; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  private nextId = 1;

  constructor(
    factory: () => Worker,
    size = Math.max(2, (navigator.hardwareConcurrency ?? 4) - 2),
  ) {
    for (let i = 0; i < size; i++) {
      const worker = factory();
      const pooled: PooledWorker = { worker, busy: false, pending: new Map() };
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as { id: number };
        const call = pooled.pending.get(msg.id);
        if (call) {
          pooled.pending.delete(msg.id);
          call.resolve(e.data);
        }
        pooled.busy = false;
        this.dispatch();
      };
      worker.onerror = (e) => {
        for (const call of pooled.pending.values()) {
          call.reject(new Error(e.message ?? 'Worker 执行失败'));
        }
        pooled.pending.clear();
        pooled.busy = false;
        this.dispatch();
      };
      this.workers.push(pooled);
    }
  }

  /** 派发任务：payload 经 postMessage 发送，transfer 列表零拷贝转移 */
  exec<T>(payload: unknown, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        payload,
        transfer,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.dispatch();
    });
  }

  private dispatch(): void {
    const idle = this.workers.find((w) => !w.busy);
    if (!idle || this.queue.length === 0) return;
    const task = this.queue.shift()!;
    idle.busy = true;
    idle.pending.set(task.id, { resolve: task.resolve, reject: task.reject });
    const msg = { ...(task.payload as Record<string, unknown>), id: task.id };
    idle.worker.postMessage(msg, task.transfer);
  }

  destroy(): void {
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
    this.queue = [];
  }
}
