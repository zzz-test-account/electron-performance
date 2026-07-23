import type { BatchWriter } from './write/batchWriter';
import type { SignalRow } from '../shared/types';
import { config } from './config';

/**
 * 演示用高频模拟数据源：多通道正弦 + 高斯噪声 + 偶发尖峰。
 *
 * 默认每 100ms 产一批，速率可调（UI 滑杆经写入通道 sim.control 下发）。
 * 背压响应：队列水位 > 0.8 时自动降到 1/4 速率（方案 §3.3 降速信号的消费者示例）。
 */
export class Simulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private rate = config.simRate;
  private throttled = false;

  constructor(private readonly writer: BatchWriter) {}

  get running(): boolean {
    return this.timer != null;
  }

  get currentRate(): number {
    return this.rate;
  }

  start(rate?: number): void {
    if (rate != null) this.rate = Math.max(100, Math.floor(rate));
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setRate(rate: number): void {
    this.rate = Math.max(100, Math.floor(rate));
  }

  /** 背压信号：来自 BatchWriter 的水位告警 */
  onBackpressure(level: number): void {
    this.throttled = level > 0.8;
  }

  private tick(): void {
    const now = Date.now();
    const effectiveRate = this.throttled ? Math.floor(this.rate / 4) : this.rate;
    const rowsPerChannel = Math.max(1, Math.floor((effectiveRate / 10) / config.simChannels));
    const rows: SignalRow[] = new Array(rowsPerChannel * config.simChannels);
    let i = 0;
    for (let ch = 0; ch < config.simChannels; ch++) {
      for (let k = 0; k < rowsPerChannel; k++) {
        // 同一批次内时间戳微错开，保持 ts 近似有序写入（zonemap 友好，方案 §3.2）
        const ts = now - (rowsPerChannel - k);
        rows[i++] = { ts, channelId: ch, value: this.sample(ch, ts) };
      }
    }
    this.writer.enqueue(rows);
  }

  private sample(channel: number, ts: number): number {
    const periodMs = 60_000 + channel * 30_000; // 各通道不同周期，便于视觉区分
    const phase = channel * 1.3;
    const base = 50 + channel * 10;
    const sine = 30 * Math.sin((2 * Math.PI * ts) / periodMs + phase);
    const noise = gaussian() * 2;
    // 千分之二概率尖峰，模拟真实信号的异常点（箱线图异常散点演示素材）
    const spike = Math.random() < 0.002 ? (Math.random() - 0.5) * 120 : 0;
    return base + sine + noise + spike;
  }
}

/** Box-Muller 高斯噪声 */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
