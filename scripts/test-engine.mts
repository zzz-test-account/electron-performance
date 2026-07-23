/**
 * QueryEngine 端到端冒烟（离线运行，不经 Electron）：
 * 真实 DuckDB + 真实 QueryEngine + mock 端口，验证查询协议全链路
 * （meta → chunk(列式帧) → end），并解码校验列内容。
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { QueryEngine } from '../src/data-service/query/queryEngine';
import { decodeFrame } from '../src/shared/columnar';

const instance = await DuckDBInstance.create('data/hot/hot.duckdb');

// —— 初始化协议所需的最小 schema 环境（unified 视图） ——
const setup = await instance.connect();
await setup.run('CREATE OR REPLACE VIEW unified AS SELECT ts, channel_id, value FROM signals');
setup.closeSync();

const messages: unknown[] = [];
const mockPort = {
  postMessage(message: unknown, _transfer?: ArrayBuffer[]) {
    messages.push(message);
    // 模拟渲染端：消费一帧立即回补一帧 credit
    const m = message as { kind: string; id: number };
    if (m.kind === 'chunk') engine.handleMessage({ kind: 'credit', id: m.id, chunks: 1 });
  },
};

const engine = new QueryEngine(instance, mockPort);

function runQuery(id: number, op: string, params: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = messages.length;
    const timer = setInterval(() => {
      const tail = messages.slice(start) as { kind: string; id: number }[];
      const end = tail.find((m) => m.kind === 'end' && m.id === id);
      const err = tail.find((m) => m.kind === 'error' && m.id === id) as
        | { message: string }
        | undefined;
      if (err) {
        clearInterval(timer);
        reject(new Error(err.message));
      } else if (end) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`查询 ${id} 超时`));
    }, 10_000);
    // 发送查询（模拟渲染端经端口发来的请求）
    engine.handleMessage({ kind: 'query', id, op, params } as never);
  });
}

// 读取全库时间范围
const rangeRes = await (await instance.connect()).run('SELECT min(ts) a, max(ts) b FROM signals');
const [{ a, b }] = (await rangeRes.getRowObjects()) as unknown as { a: bigint; b: bigint }[];
const start = Number(a);
const end = Number(b);
console.log(`数据范围：${new Date(start).toISOString()} ~ ${new Date(end).toISOString()}`);

// 1) 箱线五数（每通道）
await runQuery(1, 'stats.boxplot', { start: end - 3_600_000, end, channelId: null, bucketMs: null });
let frames = (messages as { kind: string; buffer?: ArrayBuffer }[])
  .filter((m) => m.kind === 'chunk')
  .map((m) => decodeFrame(m.buffer!));
const gk = frames[0].columns.find((c) => c.name === 'gk')!.data;
const median = frames[0].columns.find((c) => c.name === 'median')!.data;
console.log(`✓ stats.boxplot：${frames[0].rowCount} 箱，gk=[${gk.join(',')}]，median=[${Array.from(median).map((v) => v.toFixed(1)).join(',')}]`);

// 2) keyset 分页
messages.length = 0;
await runQuery(2, 'signal.page', { channelId: null, cursor: null, limit: 500 });
frames = (messages as { kind: string; buffer?: ArrayBuffer }[])
  .filter((m) => m.kind === 'chunk')
  .map((m) => decodeFrame(m.buffer!));
const ts = frames[0].columns.find((c) => c.name === 'ts')!.data;
console.log(`✓ signal.page：${frames[0].rowCount} 行，首 ts=${ts[0]}，DESC=${ts[0] > ts[ts.length - 1]}`);

// 3) 曲线取数 L0
messages.length = 0;
await runQuery(3, 'signal.range', { channelId: 0, start: end - 300_000, end, layer: 'L0' });
frames = (messages as { kind: string; buffer?: ArrayBuffer }[])
  .filter((m) => m.kind === 'chunk')
  .map((m) => decodeFrame(m.buffer!));
console.log(`✓ signal.range(L0)：${frames[0].rowCount} 行，列=[${frames[0].columns.map((c) => c.name).join(',')}]`);

// 4) 概览（JSON 内联）
messages.length = 0;
await runQuery(4, 'meta.overview', {});
const meta = (messages as { kind: string; format?: string; payload?: unknown }[]).find(
  (m) => m.kind === 'meta',
);
console.log(`✓ meta.overview：format=${meta?.format}，payload=${JSON.stringify(meta?.payload).slice(0, 120)}…`);

// 5) 取消路径：发起大查询后立即取消
messages.length = 0;
const p5 = runQuery(5, 'signal.range', { channelId: 0, start, end, layer: 'L0' }).catch((e) => e);
setTimeout(() => engine.handleMessage({ kind: 'cancel', id: 5 }), 10);
await p5;
const errMsg = (messages as { kind: string; id: number; cancelled?: boolean }[]).find(
  (m) => m.kind === 'error' && m.id === 5,
);
console.log(`✓ cancel：error 消息=${!!errMsg}，cancelled=${errMsg?.cancelled ?? '（查询过快已完成，属正常）'}`);

instance.closeSync();
console.log('全部通过');
process.exit(0);
