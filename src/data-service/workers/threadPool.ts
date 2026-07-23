import os from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * worker_threads 池（方案 §4.3 Node 侧线程池）。
 *
 * 消化数据服务进程内的重型子任务（归档导出、批量格式转换等），
 * 遵循"池化复用、超时兜底、崩溃自动补员、resourceLimits 限制单线程堆"的成熟模式。
 */

interface PendingTask {
  id: number;
  task: WorkerTask;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ArchiveCopyTask {
  type: 'archive-copy';
  dbPath: string;
  archiveDir: string;
  watermarkTs: number;
}

export type WorkerTask = ArchiveCopyTask;

export class ThreadPool {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private queue: PendingTask[] = [];
  private running = new Map<number, { task: PendingTask; worker: Worker }>();
  private nextId = 1;

  constructor(
    private readonly scriptPath: string,
    private readonly size = Math.max(1, Math.min(4, os.cpus().length - 4)),
    private readonly taskTimeoutMs = 10 * 60_000,
  ) {}

  run<T>(task: WorkerTask): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask = {
        id: this.nextId++,
        task,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: setTimeout(() => {
          // 超时兜底：杀掉卡死的 worker 并补员，任务失败返回
          const entry = this.running.get(pending.id);
          if (entry) {
            this.killWorker(entry.worker);
            this.running.delete(pending.id);
            reject(new Error(`线程池任务 ${pending.id} 超时（${this.taskTimeoutMs}ms）`));
          }
        }, this.taskTimeoutMs),
      };
      this.queue.push(pending);
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const worker = this.idle.pop() ?? this.spawnIfBelowCapacity();
      if (!worker) return;
      const pending = this.queue.shift()!;
      this.running.set(pending.id, { task: pending, worker });
      worker.postMessage({ id: pending.id, task: pending.task });
    }
  }

  private spawnIfBelowCapacity(): Worker | null {
    if (this.workers.size >= this.size) return null;
    const worker = new Worker(this.scriptPath, {
      // 限制单线程堆，防止单个导出任务吃光进程内存（方案 §7 预算制）
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const entry = this.running.get(msg.id);
      if (!entry) return;
      this.running.delete(msg.id);
      clearTimeout(entry.task.timer);
      if (msg.ok) entry.task.resolve(msg.result);
      else entry.task.reject(new Error(msg.error ?? '线程任务失败'));
      // 归池复用并继续派发
      this.idle.push(worker);
      this.dispatch();
    });
    worker.on('error', (err) => {
      this.failWorkerTasks(worker, err);
      this.killWorker(worker);
    });
    worker.on('exit', (code) => {
      if (code !== 0) this.failWorkerTasks(worker, new Error(`worker 异常退出，code=${code}`));
      this.workers.delete(worker);
      const idx = this.idle.indexOf(worker);
      if (idx >= 0) this.idle.splice(idx, 1);
      this.dispatch(); // 崩溃自动补员
    });
    this.workers.add(worker);
    return worker;
  }

  private failWorkerTasks(worker: Worker, err: Error): void {
    for (const [id, entry] of this.running) {
      if (entry.worker === worker) {
        clearTimeout(entry.task.timer);
        entry.task.reject(err);
        this.running.delete(id);
      }
    }
  }

  private killWorker(worker: Worker): void {
    void worker.terminate();
    this.workers.delete(worker);
    const idx = this.idle.indexOf(worker);
    if (idx >= 0) this.idle.splice(idx, 1);
  }

  async destroy(): Promise<void> {
    for (const w of this.workers) await w.terminate();
    this.workers.clear();
    this.idle = [];
  }
}
