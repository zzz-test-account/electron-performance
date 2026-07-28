# Performance Demo 设计文档

> Electron + Vue3 + DuckDB + WebWorker 大数据存储与高性能计算技术方案验证工程
> 版本：0.1.0 · 代码规模约 3400 行（`src/` + `scripts/`）
> 本文档基于对全部源码的逐文件阅读整理，对应《Electron大数据存储与高性能计算技术方案.md》的第一、二阶段落地。

---

## 目录

1. [工程定位与设计目标](#1-工程定位与设计目标)
2. [总体架构](#2-总体架构)
3. [构建与运行体系](#3-构建与运行体系)
4. [共享层设计（src/shared）](#4-共享层设计srcshared)
5. [主进程设计（src/main）](#5-主进程设计srcmain)
6. [Preload 桥接设计（src/preload）](#6-preload-桥接设计srcpreload)
7. [数据服务进程设计（src/data-service）](#7-数据服务进程设计srcdata-service)
8. [渲染进程设计（src/renderer）](#8-渲染进程设计srcrenderer)
9. [关键机制专题](#9-关键机制专题)
10. [端到端时序](#10-端到端时序)
11. [性能设计决策汇总](#11-性能设计决策汇总)
12. [环境变量配置](#12-环境变量配置)
13. [已知偏差与演进方向](#13-已知偏差与演进方向)

---

## 1. 工程定位与设计目标

这是一个**技术方案验证工程**（PoC），验证在 Electron 桌面端处理「千万行级时序信号数据」的完整链路是否可行，覆盖四个典型场景：

| 场景 | 验证点 |
|---|---|
| 高频写入 | 默认 1 万行/秒模拟源持续写入，不丢、不卡 UI、内存有硬顶 |
| 海量曲线 | 千万行数据任意跨度首屏亚秒，缩放/平移流畅（视口感知 + 预聚合 + 降采样） |
| 统计下钻 | 箱线五数/异常点/直方图 SQL 下推，框选箱体联动曲线下钻 |
| 明细浏览 | 千万行表滚动加载，DOM 节点恒定、查询近恒定耗时（虚拟列表 + keyset 分页） |

**技术栈**：Electron 43（utilityProcess / MessageChannelMain）+ Vue 3.5 + TypeScript + DuckDB（`@duckdb/node-api` 原生 N-API）+ ECharts 6 + Pinia 4 + Web Worker / worker_threads。

**贯穿全工程的三条总纲**：

1. **主进程只做编排不做重活** —— 主进程做 CPU 密集工作会冻结所有渲染进程；
2. **SQL 下推优先** —— 一切能在引擎侧完成的计算（过滤/聚合/分位数/直方图）绝不搬到应用层；
3. **内存预算制 + 响应式纪律** —— 大数据只以 TypedArray 形态存在，杜绝深度代理十万级对象。

---

## 2. 总体架构

### 2.1 进程与线程拓扑

```
┌──────────────────────────────────────────────────────────────────┐
│ 主进程 src/main（只编排：窗口 / 宿主管理 / 通道接线）                 │
│  ├─ BrowserWindow（渲染进程宿主）                                    │
│  ├─ DataServiceHost：utilityProcess 拉起/监控/崩溃重启/内存重生       │
│  └─ channelBroker：建连时充当"接线员"，此后退出数据通路               │
└──────────────┬───────────────────────────────┬───────────────────┘
               │ utilityProcess.fork            │ MessageChannelMain（仅建连）
               ▼                                ▼
┌─────────────────────────────┐   直连    ┌──────────────────────────────┐
│ 数据服务进程 src/data-service │ ◄═══════► │ 渲染进程 src/renderer（Vue3） │
│ （Electron utilityProcess，   │  三条通道  │  ├─ sdk/：端口桥/查询SDK/实时中枢│
│  完整 Node 环境，独占 DuckDB）│ query    │  ├─ workers/：Web Worker 池    │
│  ├─ writer：全局唯一写连接     │ write    │  │   （MinMax→LTTB 降采样）    │
│  ├─ BatchWriter：微批聚合写入  │ subscribe│  ├─ stores/：Pinia（小状态）   │
│  ├─ QueryEngine：流式查询引擎  │          │  └─ components/：图表+虚拟表   │
│  ├─ Simulator：模拟数据源      │          │                              │
│  └─ ThreadPool：worker_threads│          │                              │
│     （归档 COPY 重型子任务）   │          │                              │
└──────────────┬───────────────┘          └──────────────────────────────┘
               ▼
┌─────────────────────────────┐
│ 存储层                        │
│  data/hot/hot.duckdb（热库）  │
│  data/archive/dt=YYYY-MM-DD/ │
│    *.parquet（冷归档，Hive 分区）│
└─────────────────────────────┘
```

仓库内另有架构图 `assets/arch_overview.png`、`assets/render_pipeline.png`、`assets/write_pipeline.png` 可作对照。

### 2.2 通道拓扑（方案 §6 落地）

三条逻辑通道相互独立，避免队头阻塞：

| 通道 | 方向 | 载荷 | 代码位置 |
|---|---|---|---|
| `query` | 双向（请求/流式响应） | 查询请求、cancel、credit；meta/chunk/end/error | `queryEngine.ts` ↔ `dataClient.ts` |
| `write` | 双向（写入/背压回执） | 行追加、模拟源控制；背压信号 | `index.ts` ↔ `realtimeHub.ts` |
| `subscribe` | 单向推送 | 每秒指标 tick、微批增量 ingest | `index.ts` ↔ `realtimeHub.ts` |

关键性质：**主进程只在建连时出现**。渲染进程申请通道 → 主进程创建 `MessageChannelMain`，port1 交数据服务进程、port2 经 preload 两跳转发到渲染主世界，此后两端直连。

---

## 3. 构建与运行体系

### 3.1 双构建管线

工程有两条独立的构建管线，因为 utilityProcess 与主进程是两套入口、两种生命周期：

| 管线 | 配置文件 | 产物 | 说明 |
|---|---|---|---|
| electron-vite | `electron.vite.config.ts` | `out/main`、`out/preload`、`out/renderer` | 三端统一构建；main/preload 用 `externalizeDepsPlugin` 外置依赖 |
| vite（Node 目标） | `vite.data-service.config.ts` | `out/data-service/index.mjs`、`out/data-service/threadTask.worker.mjs` | 独立 ESM 构建，`target: node20`，`@duckdb/*` 与 `node:*` external |

要点：

- **原生模块绝不打包**：`@duckdb/node-api` 是 N-API 原生模块，两个管线都将其 external，运行时从 `node_modules` 解析。
- **data-service 输出 ESM（.mjs）**：Electron ≥ 28 的 utilityProcess 原生支持 ESM。
- **线程池 worker 独立入口**：`threadTask.worker.ts` 作为第二 entry 产出 `.mjs`，供 `worker_threads` 按磁盘路径加载。
- **`schema.sql` 经 vite `?raw` 导入**（`schema.ts`），与 `scripts/seed.mjs` 读同一文件，单一事实来源，避免两处维护漂移。

### 3.2 npm 脚本

| 脚本 | 实现 | 作用 |
|---|---|---|
| `dev` | `scripts/dev.mjs` | 先构建 data-service，再 `electron-vite dev`；启动前 `delete process.env.ELECTRON_RUN_AS_NODE`，防止本机全局设置让 Electron 退化为纯 Node |
| `build` | — | `build:data-service` + `electron-vite build` |
| `seed` | `scripts/seed.mjs` | 独立 Node 进程预灌历史数据（默认 30 天 × 4 通道 ≈ 1037 万行） |
| `typecheck` | — | `vue-tsc`（web 侧）+ `tsc`（node 侧）双侧检查 |
| `test:engine` | `scripts/test-engine.mts` | esbuild 打包后离线运行 QueryEngine 端到端冒烟（不经 Electron） |

### 3.3 seed 脚本设计（`scripts/seed.mjs`）

- 与数据服务进程**共用同一数据目录**（默认 `./data`）与**同一份 schema.sql**；
- 写入同样走 **Appender 批量直写**（50 万行/批），按 ts 升序写入以让 zonemap 剪枝生效；
- 灌完后**全量构建 L1/L2 预聚合**；
- 已灌过则跳过，`SEED_FORCE=1` 清空重灌；`SEED_DAYS` / `SEED_CHANNELS` 可调；
- 生成器与在线模拟源同族（正弦 + 高斯噪声 + 千分之二尖峰），保证离线与在线数据形态一致。

---

## 4. 共享层设计（src/shared）

三端（main / data-service / renderer）共享的唯一事实来源，共 3 个文件。

### 4.1 `types.ts` —— 领域类型

- **建模原则**：主表"窄而长"——`ts` 毫秒整型、`channel` 字典化为小整数、`value` DOUBLE。
- **预聚合层级** `SignalLayer = 'L0' | 'L1' | 'L2'`：L0 原始 / L1 分钟桶 / L2 小时桶。
- **`QueryOp` 封闭操作集**：`'signal.range' | 'signal.page' | 'stats.boxplot' | 'stats.outliers' | 'stats.histogram' | 'meta.overview'`。刻意**不暴露裸 SQL**——所有 SQL 集中在数据服务进程内生成，渲染端与存储 schema 解耦，且天然防注入、可命中 prepared 缓存。

### 4.2 `protocol.ts` —— 跨进程通信协议

四个部分（详细消息结构见 §9.1）：

1. **通道名与 IPC 事件名常量**（`CHANNELS` / `IPC_EVENTS`），preload 申请、主进程分发、数据服务绑定三处以同一常量为准；
2. **查询通道上行**：`query` / `cancel` / `credit` 三种消息，以单调分配的 `id` 关联；
3. **查询通道下行**：`meta`（声明 `cols-bin` 二进制流或 `json` 内联）→ `chunk`（列式帧）→ `end`（rowCount + elapsedMs）/ `error`（含 `cancelled` 标志区分取消与真错误）；
4. **写入/订阅通道**：`write.rows`、`sim.control`、背压 `backpressure(level)`、指标 `tick`、增量 `ingest`。

### 4.3 `columnar.ts` —— 列式二进制帧编解码

**为什么不用 Arrow IPC**：`@duckdb/node-api` 未暴露引擎侧 Arrow IPC 序列化（C API 的 `duckdb_arrow` 未上翻），Node 侧经 apache-arrow 二次打包会多一次全量拷贝。自定义帧保持同等设计目标——**列式布局 + 解码端在帧 buffer 上直接建 TypedArray 视图（零拷贝）**。

帧布局（小端，数据段 8 字节对齐）：

```
u32 magic('COL1') | u32 colCount | u32 rowCount | u32 reserved
重复 colCount 次：u16 nameLen | u8 type | u8 pad | name UTF-8 字节
对齐到 8 后：colCount 段列数据（F64 → Float64Array；I32 → Int32Array）
```

设计约束与取舍：

- **不编码 NULL 位图**：当前所有查询 SQL 均无 NULL 输出，编码端将 null 归零（`queryEngine.ts` FrameAccumulator 内处理）；
- **i64 时间戳按 f64 编码**：ms 纪元值远小于 2^53，无精度损失；
- 提供 `concatColumns()` 把多帧拼成连续列（仅在确需连续内存时用，拼接是一次拷贝）；
- 未来 DuckDB 暴露 Arrow IPC 后可**单点替换编解码层，协议不变**。

---

## 5. 主进程设计（src/main）

总原则：主进程只做窗口、建连接线、任务编排，**不做任何 CPU 密集工作**。

### 5.1 `index.ts` —— 入口

- ESM 下 `import 'electron'` 会命中 npm 壳包（导出二进制路径字符串），必须经 `createRequire` 走 Electron 的 CJS 模块钩子拿内置 API（main/preload/dataServiceHost 三处同此模式）。
- 窗口配置：`contextIsolation: true`、`sandbox: false`（preload 为 ESM .mjs 必须关 sandbox）、`nodeIntegration: false`——渲染进程不启用 Node 集成，攻击面不变。
- 启动序列：跨域隔离检查 → 拉起 DataServiceHost → 注册 channelBroker → **每 60s 内存治理巡检** → 建窗。
- **COOP/COEP 注入开关**（`ENABLE_CROSS_ORIGIN_ISOLATION=1`）：经 `session.defaultSession.webRequest.onHeadersReceived` 注入 `same-origin` / `require-corp` 头，解锁 SharedArrayBuffer / WASM threads。默认关闭；本工程资源全本地自包含，可安全开启。

### 5.2 `channelBroker.ts` —— 通道接线员

逻辑极简：监听 `data-channel:request` → 校验通道名合法性 → `new MessageChannelMain()` → port1 随 `BIND_CHANNEL` 消息发给数据服务进程 → port2 经 `event.sender.postMessage` 发回渲染进程。**此后主进程完全退出数据通路**，不会成为每秒数万行数据的搬运瓶颈。

### 5.3 `dataServiceHost.ts` —— 数据进程宿主管理

`DataServiceHost` 类负责 utilityProcess 的全生命周期：

- **拉起**：`utilityProcess.fork(entryPath, [], { env: process.env 透传, stdio: ['ignore','pipe','pipe'] })`，子进程 stdout/stderr 加 `[ds]` / `[ds!]` 前缀转发；
- **指标采集**：监听子进程上报的 `{type:'metrics'}` 消息，缓存最近一条 tick；
- **内存高水位自动重生**：`checkMemoryAndRecycle()` 发现 `rssMb > DS_HIGH_WATER_MB`（默认 2048MB）时执行**优雅重启**——先发 `shutdown` 通知排空，10s 超时兜底强杀，再重新拉起并触发 `onRestarted` 回调（渲染端据此重新建连）。思想：**把长尾泄漏转化为可控的定期回收**；
- **崩溃自动重启 + 指数退避**：非主动退出时 1s 起步、翻倍至 30s 上限重启；稳定运行超 60s 重置退避，防崩溃风暴；
- **优雅停止**：`before-quit` 时通知排空，5s 超时强杀。

---

## 6. Preload 桥接设计（src/preload）

`contextIsolation` 下的**最小桥接面**，只暴露一个 `dataBridge` 对象两个方法：

| 方法 | 语义 |
|---|---|
| `requestPort(name)` | 校验通道名 → `ipcRenderer.send` 申请 → 收到端口后用 `window.postMessage` + Transferable 转发到渲染主世界（Electron 官方推荐的两跳模式：隔离世界 → 主世界） |
| `onDataServiceRestarted(cb)` | 转发主进程的 `data-service:restarted` 通知 |

渲染进程拿不到任何 Node/Electron API，只拿得到这两个函数。类型声明在 `src/renderer/env.d.ts`（`Window.dataBridge`）。

---

## 7. 数据服务进程设计（src/data-service）

Electron utilityProcess，完整 Node.js 环境，**独占 DuckDB 原生引擎，是全局唯一写者**。

### 7.1 `config.ts` —— 集中配置

全部参数可经环境变量覆盖（主进程 fork 时透传 env），默认值面向演示调小：数据目录、DuckDB 内存预算（1536MB）、微批阈值（5 万行 / 500ms）、接入队列硬顶（200 万行）、热表保留窗口（3 天）、归档巡检间隔（10 分钟）、预聚合刷新节流（5s）、单帧最大行数（65536）、模拟源速率/通道数。完整表格见 §12。

### 7.2 `index.ts` —— 进程入口与通道绑定

启动序列：

1. `openDatabase()` → `applySchema()` → `ensureChannels()` → `ensureUnifiedView()`；
2. 创建 `BatchWriter`（唯一写管线）与 `Simulator`（演示数据源），背压回调直连：队列水位 → 模拟器降速；
3. 创建 `ThreadPool`（worker_threads 池，worker 脚本按构建产物路径定位）；
4. 挂接微批提交回调 → 向订阅者广播 `ingest` 增量通知；
5. 监听父端口消息：`BIND_CHANNEL`（接线员发来端口）或 `shutdown`（优雅退出）；
6. **每秒指标 tick**：写入速率 / 队列水位 / rss / **arrayBuffers（堆外内存）**，既推订阅通道也上报主进程（高水位重生决策依据）；
7. **归档巡检**：每 10 分钟一次 + 启动 15s 后先巡检一次（seed 的历史数据即刻归档演示）；
8. 启动模拟源。

**`unwrapPortMessage()` 坑位处理**：Electron 的 `MessagePortMain` 其 message 事件载荷为 `{data, ports}` 事件对象，而 Node 的 MessagePort 直接回调裸数据；不解包会把事件对象当请求体解析（kind 为 undefined，查询静默失败）。

**优雅退出**：收到 `shutdown` → 排空写入队列 → 销毁线程池 → 关 DuckDB → `process.exit(0)`。

### 7.3 `db/` —— 存储层

#### 7.3.1 `database.ts` —— 实例与连接管理

并发模型（DuckDB 跨进程"单写多读"）：

- 全局只有本进程持有可写连接，其他进程一律经 IPC 委托写；
- 进程内靠 MVCC 多连接：**写连接唯一**（`writer`，微批写入/预聚合刷新/归档删除都走它）；**查询连接按需创建**（QueryEngine 每查询一条，使 interrupt 能精确中断单个查询而不误伤他人）；
- DuckDB 参数：`threads = max(2, CPU数-2)`（留 2 核给渲染与主进程），`memory_limit` 超出后引擎自动落盘（temporary directory）而非 OOM。

#### 7.3.2 `schema.sql` / `schema.ts` —— 建模

四张表：

```sql
channels(id INTEGER PK, name VARCHAR)            -- 通道字典（字符串维度字典化）
signals(ts BIGINT, channel_id INTEGER, value DOUBLE)              -- L0 热表
signals_l1(ts, channel_id, avg_v, min_v, max_v, n, PK(ts,channel_id))  -- L1 分钟桶
signals_l2(ts, channel_id, avg_v, min_v, max_v, n, PK(ts,channel_id))  -- L2 小时桶
```

设计要点：

- **窄表 + 按 ts 有序写入**：让 DuckDB 的 zonemap（row group 级 min/max 统计）自动剪枝范围过滤；
- **统一视图 `unified`**：`signals ∪ read_parquet('archive/**/*.parquet', hive_partitioning=true)`，尚无归档文件时退化为仅热表（read_parquet 对空 glob 报错）；
- Windows 下 glob 路径转 POSIX 分隔符（`toGlobPath`）。

#### 7.3.3 `archive.ts` —— 热→冷归档管线

四步流程（`archiveBefore`）：

1. **导出**：COPY TO Parquet + `PARTITION_BY (dt)`，放 **worker_threads 池**执行（重型子任务不占数据服务主线程）；
2. **预聚合水位补算**：删除热表前，先把被删区间的 L1/L2 桶物化完毕（L1/L2 只从热表派生）；
3. **删除**：由全局唯一写连接删除热表已归档区间；
4. **刷新统一视图**：首次产生归档文件后 unified 才 UNION read_parquet。

查询侧用 glob 路径让**文件系统充当过滤器**（`dt=YYYY-MM-DD/` 目录树即分区裁剪）。

### 7.4 `write/batchWriter.ts` —— 高频写入管线（核心）

**核心思想**：把"每秒数千次小写入"在应用层合并成"每秒几次大写入"。

- **微批触发**：凑够 `flushRows`（5 万行）或超过 `flushMs`（500ms），先到先触发；
- **批量提交**：单事务 + **Appender 直写存储层**（绕过 SQL 解析，比逐条 INSERT 快 10–100 倍）；
- **可靠性语义**：提交成功才出队（至少一次不丢）；flush 失败则 ROLLBACK 后**批次重新入队**等待下轮，避免静默丢数据；
- **背压**：接入队列有硬顶（200 万行），水位 > 0.8 发出背压信号，生产端（模拟器）降速——内存占用有硬顶；
- **预聚合增量维护**：每次提交后节流到每 5s 一次，删除受影响时间桶再按热表重算（L1 回退 1 小时、L2 回退 1 天，覆盖正在写入的"半桶"）；
- **并发保护**：`flushing` 标志防重入；`drain()` 供优雅退出前排空（失败即放弃，防死循环）。

### 7.5 `simulator.ts` —— 演示数据源

- 每 100ms 产一批：多通道正弦（各通道不同周期/相位/基线）+ Box-Muller 高斯噪声 + **千分之二概率尖峰**（箱线图异常散点的演示素材）；
- 同批次内时间戳微错开，保持 ts 近似有序写入（zonemap 友好）；
- **背压消费者示例**：水位 > 0.8 自动降到 1/4 速率；
- UI 可经写入通道 `sim.control` 停/调速（100 行/s 下限）。

### 7.6 `query/` —— 查询引擎与 SQL 下推

#### 7.6.1 `queryEngine.ts` —— 流式查询引擎

关键设计：

- **每查询独占一条连接**（DuckDB 连接创建开销小），`conn.interrupt()` 引擎级中断精确作用于单查询；
- **强制流式分块**：SDK 层不允许无上限全量拉取；`ROW_GUARD = 500万` 软上限防误配全量物化；
- **credit 背压**：初始额度 4 帧，渲染端每消费一帧回补一帧，无额度时挂起等待——防止快查询冲高慢消费的渲染进程内存；
- **帧聚合器 `FrameAccumulator`**：DuckDB 原生 chunk（默认 2048 行）攒成 ~64k 行（约 1MB）大帧再传输，摊薄每帧消息与调度开销（`getColumns()` 返回列主序数组，BIGINT→number 转换，null 归零）；
- **跨进程边界说明**：`MessagePortMain` 的 transfer 列表只接受端口对象（传 ArrayBuffer 抛错，实测），故这一跳是结构化克隆；零拷贝链在渲染进程内部延续；
- `meta.overview` 是小结果，直接 JSON 内联不走列式帧。

#### 7.6.2 `sql.ts` —— SQL 集中构建

渲染端只发结构化 `QueryOp`，SQL 在此统一生成并参数化（`$1/$2/...` 占位，同形语句命中 prepared 缓存）：

| 操作 | SQL 策略 |
|---|---|
| `signal.range` | L0 穿透 `unified`（热+冷），L1/L2 走预聚合表取 `avg_v`；`ORDER BY ts` + ROW_GUARD |
| `signal.page` | **keyset 分页**：`WHERE ts < cursor ORDER BY ts DESC LIMIT n`，借 ts 有序性与 zonemap 近恒定耗时，避免深 OFFSET 全量扫描；channelId 可空（`$1::INTEGER IS NULL OR ...` 模式） |
| `stats.boxplot` | 五数在 SQL 层聚合（`approx_quantile` 单次扫描近似），**按时间桶一条 SQL 产出全部箱体**，每箱仅回传 7 个标量；也支持按通道分组 |
| `stats.outliers` | CTE 先算 Q1/Q3，再取 1.5×IQR 越界点的 `(ts, value)`；`LIMIT maxPoints` 防极端分布回传膨胀 |
| `stats.histogram` | CTE 先算 min/max，再等宽分桶 `count(*)`，bin 号 + lo/hi 回传供渲染端换算 |

### 7.7 `workers/` —— worker_threads 池

**`threadPool.ts`**（数据服务进程侧，消化重型子任务）：

- 池大小 `max(1, min(4, CPU数-4))`，任务超时 10 分钟兜底；
- **超时杀 worker 并补员**、**崩溃自动补员**（exit 非 0 → 任务失败 + 移除 + dispatch 触发补员）；
- `resourceLimits: { maxOldGenerationSizeMb: 512 }` 限制单线程堆（内存预算制延伸到线程内）；
- 成熟模式：池化复用、空闲归池、任务队列派发。

**`threadTask.worker.ts`**（任务执行体）：当前唯一任务类型 `archive-copy`——经 `DuckDBInstance.fromCache(dbPath)` **共享同一库文件**（进程内单实例缓存），与主数据线程的写连接互不阻塞；`COPY ... TO ... (FORMAT PARQUET, PARTITION_BY (dt), OVERWRITE_OR_IGNORE)` 自动生成 `dt=YYYY-MM-DD/` 目录树。

---

## 8. 渲染进程设计（src/renderer）

Vue 3 + Pinia + vue-router（hash 模式，避免 file:// 路径问题）+ ECharts 按需注册（`echarts/core` 树摇）。

### 8.1 `sdk/` —— 数据访问层

#### 8.1.1 `portBridge.ts` —— 端口桥

`acquirePort(name)`：监听 `window message` 等 preload 两跳转发来的端口，Promise 缓存去重；`resetPorts()` 在数据进程重启后清空缓存（旧端口全部失效）；`onDataServiceRestarted()` 封装重启通知。

#### 8.1.2 `dataClient.ts` —— 查询 SDK（渲染进程唯一数据入口，全局单例）

- **queryId 生命周期**：`slot`（槽位）语义——同槽位只允许一个活跃查询，新查询自动 cancel 旧的（如用户连续拖动 dataZoom）；
- **流式帧聚合**：逐帧 `decodeFrame`（零拷贝视图），`end` 时 `concatColumns` 按需拼成连续列；
- **credit 背压回执**：每收一帧立即回补一帧额度；
- **LRU 缓存**（容量 32）：同 cacheKey 直接命中，给缩放/平移等高频交互的服务端压力削峰；
- **内存纪律**：大结果只以 TypedArray 形态存在，绝不物化为 JS 对象数组；迟到帧（已取消/超时查询）直接丢弃；
- **重启恢复**：`reset()` 拒绝全部悬挂 Promise、清空槽位与缓存；
- 面向组件的语义化方法：`overview / signalRange / signalPage / boxplotByBucket / outliers`。

#### 8.1.3 `realtimeHub.ts` —— 实时中枢

管理写入通道与订阅通道：`simControl`（开关/调速）、`writeRows`（外部数据写入入口，预留）、`onTick` / `onIngest` / `onBackpressure` 回调。

### 8.2 `workers/` —— Web Worker 降采样

**`workerPool.ts`**：常驻 Worker 池（大小 `hardwareConcurrency - 2`），启动一次性创建避免每任务 30–50ms 建线开销；Promise 化 RPC（Comlink 风格最小实现）；载荷一律 Transferable。

**`lttb.worker.ts`**：零三方依赖的 MinMax→LTTB 降采样——

- 输入超过阈值 8 倍时先 **MinMax 预选**（每桶保 min/max 两点，保持时间先后顺序避免折线回折）把 LTTB 输入压缩一个量级；
- **LTTB**（Largest-Triangle-Three-Buckets）O(n) 保形降采样，Uber M3、TimescaleDB 同款算法；
- 输入/输出均走 **Transferable**（O(1) 指针交换）。

**`downsampleService.ts`**：池 + Transferable 的封装；约定"调用后 x/y 底层 buffer 已转移不可再读"。

### 8.3 `stores/appStore.ts` —— 状态管理

Pinia store **只放小状态**：库概览、选中通道、时间视口、实时跟随标志、每秒指标、模拟源状态。大载荷（曲线点列、窗口行集）一律放组件内 `shallowRef` 或模块级变量。核心 action：`setRange`（退出实时跟随）、`slideToNow`（保持跨度滑到最新）。

### 8.4 组件设计

#### 8.4.1 `SignalChart.vue` —— 海量曲线（视口感知数据供给管线）

管线：`dataZoom/视口变化（150ms 去抖）→ 按跨度选层 → SQL 下推取数 → Worker 降采样 → ECharts`

- **视口感知选层** `pickLayer`：跨度 > 14 天 → L2（小时桶）；> 2 天 → L1（分钟桶）；否则 L0；
- **总纲**：交给 ECharts 的点数 ≤ 容器像素宽 × 2（超过此数的点必然在物理像素上重叠）；
- 查询槽位 `'signal-chart'`：拖动缩放期间新查询自动取消旧查询；
- **ECharts 大数据配置**：`animation:false` / `sampling:'lttb'`（内置兜底双保险）/ `large:true` / `progressive:4000`；
- **防循环标志** `applyingZoom`：程序化 setOption 不会再次触发 datazoom 加载；
- 实时跟随：`onIngest` → `slideToNow(maxTs)`（拉模式刷新）；
- 细节：`shallowRef` 持图表实例、`toRaw().setOption` 绕过响应式 diff、ResizeObserver 监听像素预算变化、卸载时 `dispose()` 断开数据引用；
- 面板信息条实时显示：`N 行 → M 点 · Lx 层 · SQL xxms`（管线透明化，便于验收）。

#### 8.4.2 `BoxplotPanel.vue` —— 箱线统计与联动下钻

- 纪律：五数与异常判定**全部在 SQL 层完成**，渲染层只拿每箱一行聚合结果 + ≤500 个越界散点；
- **桶宽选择** `pickBucketMs`：把跨度切成约 40 桶，对齐到"好看"的候选桶宽（1s ~ 7 天）；
- 异常散点经 `桶起点 → 类目下标` 映射贴到所属箱体；
- **两条联动路径**：点击单箱体 → 下钻到该时间桶；brush 框选多箱体 → 类目区间换算回绝对时间范围写回 store → SignalChart 穿透到更细的层展示原始形态（框选后清除刷选框）。

#### 8.4.3 `VirtualTable.vue` + `VirtualList.vue` + `TableRow.vue` —— 明细浏览

- `VirtualList`：零依赖自研固定行高虚拟列表——幻影层撑出完整滚动高度 + 内容层 `translateY` 平移 + 只渲染可视区及前后 8 行缓冲，DOM 节点恒定在几十个；选型的考虑：固定行高场景逻辑极薄，自研避免 UMD 老库兼容问题，未来需动态行高再换 `@tanstack/vue-virtual`（接口保持不变）；
- `VirtualTable`：滚动接近底部（<200px）拉下一页；**keyset 游标** = 上一页 DESC 序最后一行的 ts；`shallowRef` 行集整体替换（一次赋值一次触发）；**内存窗口硬顶** MAX_PAGES=40 页（2 万行），超出从头部裁掉旧页。

### 8.5 `Dashboard.vue` —— 总装

- 顶部指标条：写入速率 / 累计行数 / 队列水位（>50% 告警色）/ DS rss / 堆外 arrayBuffers（>256MB 告警色）——内存治理可视化；
- 控制条：通道切换、实时跟随、快捷视口（5 分钟/1 小时/1 天/7 天/全部范围）、模拟源开关与调速滑杆；
- **重启自愈**：`onDataServiceRestarted` → 显示"重启中"→ reset 两个 SDK → 重新 bootstrap（建连 + 拉概览）。

---

## 9. 关键机制专题

### 9.1 查询协议时序

```
渲染端 (dataClient)                    数据服务 (QueryEngine)
     │  {kind:'query', id, op, params}      │
     │ ───────────────────────────────────► │ 独占新连接，credit=4
     │  {kind:'meta', id, format:'cols-bin'}│
     │ ◄─────────────────────────────────── │
     │  {kind:'chunk', id, buffer(≤64k行)}  │ credit--
     │ ◄─────────────────────────────────── │
     │  {kind:'credit', id, chunks:1}       │ （消费一帧回补一帧）
     │ ───────────────────────────────────► │
     │            …… 重复 ……                │ credit=0 时挂起等待
     │  {kind:'end', id, rowCount, elapsed} │
     │ ◄─────────────────────────────────── │ 关连接
取消路径：
     │  {kind:'cancel', id}                 │ conn.interrupt() 引擎级中断
     │ ───────────────────────────────────► │ 流迭代抛错 → {kind:'error', cancelled:true}
```

### 9.2 三层背压体系

| 层 | 机制 | 阈值 | 消费者 |
|---|---|---|---|
| 写入接入 | 队列水位信号 | 水位 > 0.8（200 万行硬顶） | 模拟器降速至 1/4；写入通道回传 backpressure |
| 查询流式 | credit 额度 | 初始 4 帧，消费一帧补一帧 | QueryEngine 挂起等待 |
| 内存治理 | rss 高水位 | 2048MB | 主进程优雅重生数据进程 |

### 9.3 取消与去抖

- **交互去抖**：缩放/平移/切通道统一 150ms 去抖，服务端压力削一个数量级；
- **槽位取消**：同 slot 新查询自动 cancel 旧查询 → `conn.interrupt()` 引擎级中断（原生 DuckDB 收益之一）；
- **LRU 缓存**：32 槽，同 key 直接命中；
- 三层叠加，连续拖动 dataZoom 时服务端实际执行的查询数被压到最低。

### 9.4 零拷贝边界（诚实声明）

| 跳 | 机制 | 是否零拷贝 |
|---|---|---|
| 数据服务 → 渲染进程 | MessagePortMain 结构化克隆（transfer 只接受端口对象，实测传 ArrayBuffer 抛错） | ✗（用 ~64k 行大帧摊薄） |
| SDK 解码 | 帧 buffer 上建 TypedArray 视图 | ✓ |
| UI 线程 ↔ Web Worker | Transferable 转移（输入/输出双向） | ✓ |
| 演进方向 | SharedArrayBuffer 环形队列（`ENABLE_CROSS_ORIGIN_ISOLATION=1` 已内置开关） | 预留 |

### 9.5 内存治理

- **预算制**：DuckDB `memory_limit`（1536MB，超出自动落盘）；worker_threads 单线程堆 512MB；接入队列 200 万行硬顶；渲染端窗口 40 页硬顶；
- **盯堆外**：`arrayBuffers` 字段是长运行内存膨胀头号元凶，每秒上报并在 UI 可视化；
- **高水位自动重生**：rss 超 2048MB 时排空重启，把长尾泄漏转化为可控的定期回收；崩溃重启带指数退避；
- **渲染端配合**：重启通知 → 清悬挂状态 → 重新建连 → 重新拉概览。

### 9.6 响应式纪律（Vue3）

- ECharts 实例等第三方大对象用 `shallowRef` 持有、`toRaw()` 操作；
- 行集/点列用 `shallowRef` 整体替换，不做元素级深度代理；
- Pinia 只放小状态；
- 组件卸载显式 `dispose()` 图表并断开引用。

---

## 10. 端到端时序

### 10.1 应用启动

```
main: app.ready → 拉起 utilityProcess → 注册 channelBroker → 建窗
data-service: 开库 → 建表/视图 → BatchWriter+Simulator+ThreadPool → 15s后首次归档巡检 → 模拟源开跑
renderer: bootstrap → dataClient.init + realtimeHub.init（各经 preload→main 建连）
        → overview 拉库概览 → 实时跟随滑到最新 → SignalChart/BoxplotPanel/VirtualTable 各自取数
```

### 10.2 实时写入刷新（拉模式）

```
Simulator.tick(100ms) → BatchWriter.enqueue → 满 5万行/500ms → 事务+Appender 提交
  → onFlush → 广播 ingest{maxTs,count} → 渲染端 followLive 时 slideToNow → 视口变化触发重新取数
  → 每 5s 节流增量刷新 L1/L2 预聚合
```

### 10.3 归档

```
每 10 分钟巡检：热表中 ts < now-3天 的数据
  → 线程池 COPY → archive/dt=YYYY-MM-DD/*.parquet
  → 补算被删区间 L1/L2 桶 → 删除热表旧区间 → 刷新 unified 视图
  → 后续历史查询自动穿透 Parquet（分区裁剪生效）
```

### 10.4 箱线联动下钻

```
用户 brush 框选箱体 → 类目下标 → currentBucketStarts 换算绝对时间范围
  → store.setRange（退出实时跟随）→ SignalChart watch 触发
  → pickLayer 按新跨度选更细的层 → SQL 取数 → Worker 降采样 → 曲线呈现该区间原始形态
```

---

## 11. 性能设计决策汇总

| # | 决策 | 位置 | 收益 |
|---|---|---|---|
| 1 | DuckDB 独立 utilityProcess，主进程不碰数据 | 全工程 | 引擎崩溃/重计算不冻结 UI |
| 2 | 主进程只建连，MessageChannel 渲染↔数据直连 | channelBroker | 主进程不成为每秒数万行搬运瓶颈 |
| 3 | 三通道分离 | protocol | 查询/写入/订阅互不队头阻塞 |
| 4 | 微批聚合 + 单事务 Appender | batchWriter | 比逐条 INSERT 快 10–100 倍 |
| 5 | 接入队列硬顶 + 背压降速 | batchWriter/simulator | 内存有硬顶，不丢数据（至少一次） |
| 6 | 窄表建模 + ts 有序写入 | schema/seed | zonemap 自动剪枝范围过滤 |
| 7 | 热库 + Hive 分区 Parquet + 统一视图 | db/ | 热表恒定小、历史可查、文件系统即分区裁剪 |
| 8 | 归档导出放 worker_threads | threadPool | 重型 IO 不占数据服务主线程 |
| 9 | SQL 下推一切统计 | sql.ts | 千万行 → 每箱 7 个标量，传输量降 6–7 个数量级 |
| 10 | 封闭 QueryOp + 参数化 | types/sql | 防注入、命中 prepared 缓存、渲染端与 schema 解耦 |
| 11 | 每查询独占连接 + interrupt | queryEngine | 引擎级精确取消 |
| 12 | 流式分块 ~64k 行大帧 + credit 背压 | queryEngine/columnar | 摊薄克隆开销、防快查询冲高渲染端内存 |
| 13 | 自定义列式帧（替代 Arrow IPC） | columnar | 避免 apache-arrow 二次打包多一次全量拷贝 |
| 14 | 预聚合金字塔 L0/L1/L2 + 视口选层 | schema/SignalChart | 任意跨度首屏亚秒 |
| 15 | Worker MinMax→LTTB 降至 像素×2 | lttb.worker | 主线程零阻塞，只画有视觉信息的点 |
| 16 | Transferable 全链（渲染进程内） | workers/sdk | O(1) 指针交换替代结构化克隆 |
| 17 | 去抖 + 槽位取消 + LRU | debounce/dataClient | 高频交互服务端压力削峰 |
| 18 | keyset 分页替代 OFFSET | sql/VirtualTable | 深翻页近恒定耗时 |
| 19 | 自研虚拟列表 | VirtualList | DOM 恒定几十个，60fps |
| 20 | shallowRef/toRaw 响应式纪律 | 各组件 | 杜绝深度代理十万级对象 |
| 21 | ECharts large/progressive/无动画/按需注册 | echartsSetup/组件 | 渲染吞吐与包体积 |
| 22 | DuckDB threads=CPU-2、memory_limit | database | 与 UI 共享终端不打满整机、超预算落盘不 OOM |
| 23 | 每秒 tick 盯 rss+arrayBuffers，高水位重生 | index/host | 长尾泄漏转化为可控定期回收 |
| 24 | 崩溃指数退避重启 | dataServiceHost | 防崩溃风暴 |

---

## 12. 环境变量配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` | `./data` | 数据根目录（热库 `hot/`、归档 `archive/`） |
| `DB_MEMORY_LIMIT` | `1536MB` | DuckDB 内存预算（超出自动落盘） |
| `FLUSH_ROWS` / `FLUSH_MS` | `50000` / `500` | 微批触发阈值（先到先触发） |
| `QUEUE_CAPACITY_ROWS` | `2000000` | 接入缓冲硬顶（水位 >80% 触发背压） |
| `HOT_RETENTION_MS` | 3 天 | 热表保留窗口，之外归档 Parquet |
| `ARCHIVE_INTERVAL_MS` | 10 分钟 | 归档巡检间隔 |
| `AGG_REFRESH_MS` | `5000` | 预聚合刷新节流 |
| `FRAME_ROWS` | `65536` | 单传输帧最大行数 |
| `SIM_RATE` / `SIM_CHANNELS` | `10000` / `4` | 模拟源速率（行/秒）与通道数 |
| `DS_HIGH_WATER_MB` | `2048` | 数据进程 rss 高水位（触发排空重生） |
| `ENABLE_CROSS_ORIGIN_ISOLATION` | 关 | 置 `1` 注入 COOP/COEP（解锁 SAB） |
| `SEED_DAYS` / `SEED_CHANNELS` / `SEED_FORCE` | `30` / `4` / — | seed 脚本参数 |

---

## 13. 已知偏差与演进方向

与方案文档的偏差（README 亦有声明）：

1. **传输编码用自定义列式帧而非 Arrow IPC**：`@duckdb/node-api` 未暴露引擎侧 Arrow IPC 序列化；帧格式保持同等目标，未来可单点替换编解码层，协议不变。
2. **跨进程一跳是结构化克隆而非 Transferable**：Electron `MessagePortMain` transfer 列表仅接受端口对象（实测）；零拷贝链在渲染进程内部完整保留。演进方向是 SharedArrayBuffer 环形队列（COOP/COEP 开关已内置）。
3. **数据目录默认 `./data` 而非 `userData/data`**：便于 seed 与调试，`DATA_DIR` 可切回任意位置。
4. **第三阶段未实现**：Rust/WASM 降采样核、WASM threads、打包分发，预留扩展点。

代码内预留的扩展点：

- `realtimeHub.writeRows()`：外部数据写入入口（协议与管线已就绪）；
- `subscribe` 通道 `ingest` 为拉模式刷新信号，增量 Arrow 推送为预留扩展点；
- 路由仅单视图，骨架为多页面（性能看板、归档管理）预留；
- `WorkerTask` 联合类型当前仅 `archive-copy`，线程池可承载更多重型任务类型。

### 附：验证工具

`scripts/test-engine.mts`（`npm run test:engine`）：离线端到端冒烟——真实 DuckDB + 真实 QueryEngine + mock 端口，验证查询协议全链路（meta → chunk → end）、解码校验列内容、keyset 分页、L0 取数、JSON 概览、cancel 中断路径。
