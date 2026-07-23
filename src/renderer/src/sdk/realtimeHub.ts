import type { FromSubscribeChannel, ToWriteChannel } from '../../../shared/protocol';
import { acquirePort, CHANNELS } from './portBridge';

/**
 * 实时中枢：管理写入通道与订阅通道（方案 §6：通道按数据域拆分，互不队头阻塞）。
 *
 * - 写入通道：模拟数据源控制（开关/调速）、外部数据写入入口；
 * - 订阅通道：每秒指标 tick（速率/水位/内存）与微批提交增量通知。
 */
class RealtimeHub {
  private writePort: MessagePort | null = null;
  private subscribePort: MessagePort | null = null;

  onTick: ((msg: Extract<FromSubscribeChannel, { kind: 'tick' }>) => void) | null = null;
  onIngest: ((msg: Extract<FromSubscribeChannel, { kind: 'ingest' }>) => void) | null = null;
  onBackpressure: ((level: number) => void) | null = null;

  async init(): Promise<void> {
    const [writePort, subscribePort] = await Promise.all([
      acquirePort(CHANNELS.WRITE),
      acquirePort(CHANNELS.SUBSCRIBE),
    ]);
    this.writePort = writePort;
    this.subscribePort = subscribePort;

    this.writePort.onmessage = (e: MessageEvent) => {
      const msg = e.data as { kind: string; level?: number };
      if (msg.kind === 'backpressure' && msg.level != null) this.onBackpressure?.(msg.level);
    };
    this.subscribePort.onmessage = (e: MessageEvent) => {
      const msg = e.data as FromSubscribeChannel;
      if (msg.kind === 'tick') this.onTick?.(msg);
      else if (msg.kind === 'ingest') this.onIngest?.(msg);
    };
  }

  reset(): void {
    this.writePort = null;
    this.subscribePort = null;
  }

  /** 模拟数据源控制：running 开关 / rate 调速（行/秒） */
  simControl(control: { running?: boolean; rate?: number }): void {
    this.writePort?.postMessage({ kind: 'sim.control', ...control } satisfies ToWriteChannel);
  }

  /** 外部数据写入入口（预留）：[ts, channelId, value] 行组，经微批队列入库 */
  writeRows(rows: [number, number, number][]): void {
    this.writePort?.postMessage({ kind: 'write.rows', rows } satisfies ToWriteChannel);
  }
}

export const realtimeHub = new RealtimeHub();
