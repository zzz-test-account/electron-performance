/**
 * 列式二进制帧编解码（三端共享的唯一实现）。
 *
 * 背景（对应方案文档 §6）：理想的传输编码是 Arrow IPC，但 @duckdb/node-api
 * 目前未暴露引擎侧 Arrow IPC 序列化能力，在 Node 侧用 apache-arrow 二次打包
 * 会多一次全量拷贝。本帧格式与 Arrow IPC 设计目标一致：
 *   列式布局 → 解码端直接在帧 buffer 上建 TypedArray 视图（零拷贝）。
 *
 * 关于零拷贝边界：跨进程的 MessagePortMain 不支持 ArrayBuffer transfer
 * （transfer 列表仅接受端口对象），数据服务 → 渲染进程这一跳是结构化克隆；
 * 渲染进程内部（UI 线程 ↔ Web Worker）仍按方案以 Transferable 转移实现零拷贝。
 * 因此帧尺寸取 ~64k 行（约 1MB）摊薄克隆与消息开销，并配 credit 背压限速。
 * 若未来需要跨进程真零拷贝，可演进为 SharedArrayBuffer 环形队列（需开启 COOP/COEP）。
 *
 * 帧布局（小端，所有数据段 8 字节对齐）：
 *   u32 magic('COL1') | u32 colCount | u32 rowCount | u32 reserved
 *   重复 colCount 次：u16 nameLen | u8 type | u8 pad | name UTF-8 字节
 *   对齐到 8 后：colCount 段列数据（type=F64 → Float64Array；type=I32 → Int32Array）
 *
 * 约束：本帧不编码 NULL 位图（当前查询 SQL 均无 NULL 输出，编码端将 null 归零）；
 * i64 时间戳按 f64 编码（ms 纪元值远小于 2^53，无精度损失）。
 */

export const COL_BIN_MAGIC = 0x434f4c31; // 'COL1'

export const enum ColType {
  F64 = 1,
  I32 = 2,
}

export interface EncodeColumn {
  name: string;
  type: ColType;
  values: ArrayLike<number>;
}

export interface DecodedColumn {
  name: string;
  type: ColType;
  /** 直接建立在帧 buffer 上的视图，零拷贝；注意帧被转移后原 buffer 即失效 */
  data: Float64Array | Int32Array;
}

export interface DecodedFrame {
  rowCount: number;
  columns: DecodedColumn[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 编码一个列式帧，返回新分配的 ArrayBuffer */
export function encodeFrame(columns: EncodeColumn[], rowCount: number): ArrayBuffer {
  const names = columns.map((c) => textEncoder.encode(c.name));
  let headerSize = 16;
  for (const n of names) headerSize += 4 + n.length;
  const dataOffset = align8(headerSize);
  let total = dataOffset;
  for (const c of columns) total = align8(total) + rowCount * (c.type === ColType.F64 ? 8 : 4);

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(0, COL_BIN_MAGIC, true);
  view.setUint32(4, columns.length, true);
  view.setUint32(8, rowCount, true);
  view.setUint32(12, 0, true);

  let pos = 16;
  columns.forEach((c, i) => {
    const n = names[i];
    view.setUint16(pos, n.length, true);
    view.setUint8(pos + 2, c.type);
    view.setUint8(pos + 3, 0);
    bytes.set(n, pos + 4);
    pos += 4 + n.length;
  });

  pos = dataOffset;
  for (const c of columns) {
    pos = align8(pos);
    if (c.type === ColType.F64) {
      // ArrayLike<number> → Float64Array（TypedArray 输入时 set 为内存块拷贝，开销极小）
      const col = new Float64Array(buffer, pos, rowCount);
      col.set(c.values);
      pos += rowCount * 8;
    } else {
      const col = new Int32Array(buffer, pos, rowCount);
      col.set(c.values);
      pos += rowCount * 4;
    }
  }
  return buffer;
}

/** 解码：列数据为帧 buffer 上的 TypedArray 视图，不发生拷贝 */
export function decodeFrame(buffer: ArrayBuffer): DecodedFrame {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== COL_BIN_MAGIC) throw new Error('非法列式帧：magic 不匹配');
  const colCount = view.getUint32(4, true);
  const rowCount = view.getUint32(8, true);

  const meta: { name: string; type: ColType }[] = [];
  let pos = 16;
  for (let i = 0; i < colCount; i++) {
    const nameLen = view.getUint16(pos, true);
    const type = view.getUint8(pos + 2) as ColType;
    const name = textDecoder.decode(new Uint8Array(buffer, pos + 4, nameLen));
    meta.push({ name, type });
    pos += 4 + nameLen;
  }

  pos = align8(pos);
  const columns: DecodedColumn[] = meta.map((m) => {
    pos = align8(pos);
    const data =
      m.type === ColType.F64
        ? new Float64Array(buffer, pos, rowCount)
        : new Int32Array(buffer, pos, rowCount);
    pos += rowCount * (m.type === ColType.F64 ? 8 : 4);
    return { name: m.name, type: m.type, data };
  });

  return { rowCount, columns };
}

/** 把多帧同构数据拼接为单列连续数组（仅在确需连续内存时使用，拼接本身是一次拷贝） */
export function concatColumns(frames: DecodedFrame[]): Map<string, Float64Array | Int32Array> {
  const result = new Map<string, Float64Array | Int32Array>();
  if (frames.length === 0) return result;
  const names = frames[0].columns.map((c) => c.name);
  const types = frames[0].columns.map((c) => c.type);
  const totalRows = frames.reduce((s, f) => s + f.rowCount, 0);
  const outs = names.map((name, i) => {
    const out = types[i] === ColType.F64 ? new Float64Array(totalRows) : new Int32Array(totalRows);
    result.set(name, out);
    return out;
  });
  let offset = 0;
  for (const f of frames) {
    f.columns.forEach((c, i) => {
      (outs[i] as Float64Array).set(c.data as Float64Array, offset);
    });
    offset += f.rowCount;
  }
  return result;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}
