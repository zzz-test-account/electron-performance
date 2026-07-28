# 端到端时序详解（代码位置 · 调用栈 · 数据链路）

> 本文档是 `DESIGN.md` 第 10 节「端到端时序」的逐代码落地版。
> 对四条时序（应用启动 / 实时写入刷新 / 归档 / 箱线联动下钻）逐步给出：
> **代码位置**（`文件:行号` + 函数名）、**调用栈**（跨进程/跨线程调用链）、**数据链路**（流转的数据形态与协议消息）。
> 行号以当前工作区源码为准；协议消息定义统一位于 `src/shared/protocol.ts`，领域类型位于 `src/shared/types.ts`。

## 目录

1. [应用启动（DESIGN §10.1）](#1-应用启动design-101)
2. [实时写入刷新——拉模式（DESIGN §10.2）](#2-实时写入刷新拉模式design-102)
3. [归档（DESIGN §10.3）](#3-归档design-103)
4. [箱线联动下钻（DESIGN §10.4）](#4-箱线联动下钻design-104)
5. [附：公共链路索引](#5-附公共链路索引)

---

## 1. 应用启动（DESIGN §10.1）

### 1.0 时序总览

```
main:          app.whenReady → DataServiceHost.start(utilityProcess.fork) → setupChannelBroker → createWindow
data-service:  main() → openDatabase → applySchema/ensureChannels/ensureUnifiedView
               → BatchWriter + Simulator + ThreadPool → onFlush 挂接 → 父端口监听
               → 每秒 tick → 归档巡检定时器（10min + 15s 首次）→ simulator.start()
renderer:      main.ts 挂载 → Dashboard.onMounted → bootstrap()
               → dataClient.init + realtimeHub.init（三条通道各经 preload→main 建连）
               → dataClient.overview → store.slideToNow → 三组件各自首次取数
```

### 1.1 主进程启动序列

**步骤 M1：app 就绪，拉起数据服务进程**

- 代码位置：`src/main/index.ts:73` `app.whenReady().then(...)`；`:76-77` `new DataServiceHost(...)` + `host.start()`
- 调用栈：
  ```
  app.whenReady
    └─ DataServiceHost.start()                        src/main/dataServiceHost.ts:32
         └─ spawn()                                   src/main/dataServiceHost.ts:77
              └─ utilityProcess.fork(entryPath, [], { env, stdio })   :78
  ```
- 数据链路：
  - `entryPath` 由 `dataServiceEntry(__dirname)` 算出（`src/main/dataServiceHost.ts:127`），指向构建产物 `out/data-service/index.mjs`；
  - `env: { ...process.env }` 把全部环境变量透传给子进程（`DATA_DIR` / `SIM_RATE` 等配置经此注入，见 `src/data-service/config.ts:8`）；
  - `stdio: ['ignore','pipe','pipe']`，子进程 stdout/stderr 加 `[ds]` / `[ds!]` 前缀转发（`:86-87`）；
  - 挂 `child.on('message')` 缓存 `{type:'metrics'}` 上报（`:89-91`）、`child.on('exit')` 做崩溃指数退避重启（`:93-104`）。

**步骤 M2：注册通道接线员 + 内存巡检 + 建窗**

- 代码位置：`src/main/index.ts:78` `setupChannelBroker(host)`；`:81` `setInterval(() => host?.checkMemoryAndRecycle(), 60_000)`；`:83` `createWindow()`
- 调用栈：
  ```
  setupChannelBroker(host)                  src/main/channelBroker.ts:17
    └─ ipcMain.on('data-channel:request')   src/main/channelBroker.ts:20（待机，见 1.4）
  createWindow()                            src/main/index.ts:23
    └─ new BrowserWindow({ preload: out/preload/index.mjs, contextIsolation:true, sandbox:false })   :24-35
    └─ host.onRestarted = () => webContents.send('data-service:restarted')   :38-40
    └─ loadURL(dev) / loadFile(prod)        :42-46
  ```
- 数据链路：窗口加载 `out/renderer/index.html`（或 dev server URL），渲染进程开始执行 `src/renderer/src/main.ts:7` `createApp(App).use(createPinia()).use(router).mount('#app')`，hash 路由 `/` 命中 `Dashboard.vue`（`src/renderer/src/router.ts:8-11`）。

### 1.2 数据服务进程启动序列

- 代码位置：`src/data-service/index.ts:51` `async function main()`（进程入口，`:194` 调用）

**步骤 D1：开库建表**

- 调用栈与数据链路：
  ```
  main()
    ├─ openDatabase()                       src/data-service/db/database.ts:23
    │    ├─ mkdir data/hot、data/archive    :24-27
    │    ├─ DuckDBInstance.create('data/hot/hot.duckdb',
    │    │     { threads: max(2,CPU-2), memory_limit: '1536MB' })     :30-34
    │    └─ instance.connect() → writer（全局唯一写连接）               :35
    ├─ applySchema(writer)                  src/data-service/index.ts:53
    │    └─ 逐句执行 schema.sql（channels / signals / signals_l1 / signals_l2）
    │                                       src/data-service/db/schema.ts:11-16
    ├─ ensureChannels(writer, simChannels=4)  src/data-service/index.ts:54
    │    └─ INSERT OR IGNORE INTO channels → CH-0..CH-3 字典行
    │                                       src/data-service/db/schema.ts:19-23
    └─ ensureUnifiedView(writer, archiveDir)  src/data-service/index.ts:55
         └─ CREATE OR REPLACE VIEW unified：有 Parquet 时 = signals ∪ read_parquet(glob, hive_partitioning=true)，
            否则仅 signals                src/data-service/db/schema.ts:30-40
  ```

**步骤 D2：组建写入管线与线程池**

- 代码位置：`src/data-service/index.ts:57-68`
- 调用栈与数据链路：
  ```
  new BatchWriter(db.writer)                :57（内部启动 flushMs=500ms 定时器，src/data-service/write/batchWriter.ts:27-29）
  new Simulator(batchWriter)                :58
  batchWriter.onBackpressure = level => simulator.onBackpressure(level)   :59（背压直连）
  new ThreadPool('.../threadTask.worker.mjs')  :61-63（池大小 max(1, min(4, CPU-4))，src/data-service/workers/threadPool.ts:37）
  batchWriter.onFlush = ({count, maxTs}) => broadcast({kind:'ingest', maxTs, count})   :66-68
  ```
- `broadcast`（`:160-168`）向 `subscribers` 集合中所有订阅通道端口推送 `IngestMsg`（协议定义 `src/shared/protocol.ts:148-152`）。

**步骤 D3：挂父端口监听、指标 tick、归档巡检、启动模拟源**

- 代码位置：`src/data-service/index.ts`
- 数据链路：
  - `:71-81` `parentPort.on('message')`：等待主进程发来 `{type:'data-channel:bind', name}` + port（建连，见 1.4），或 `{type:'shutdown'}`（优雅退出 → `gracefulShutdown` `:182-192`：drain → pool.destroy → closeSync → exit(0)）；
  - `:84-97` 每秒组装 `MetricsTickMsg {kind:'tick', writtenTotal, rowsPerSec, queueLevel, rssMb, arrayBuffersMb}`，一路 `broadcast` 给订阅者，一路 `parentPort.postMessage({type:'metrics', payload})` 上报主进程（高水位重生决策依据，`src/main/dataServiceHost.ts:46-54`）；
  - `:100-110` 归档巡检：`setInterval(archiveIntervalMs=10min)` + `setTimeout(15s)` 首次巡检（详见第 3 章）；
  - `:113` `simulator.start()`：100ms 定时器产批（详见第 2 章）。

### 1.3 渲染进程 bootstrap

- 代码位置：`src/renderer/src/views/Dashboard.vue:62` `onMounted` → `:51` `bootstrap()`

**步骤 R1：双 SDK 初始化（三条逻辑通道建连）**

- 调用栈：
  ```
  bootstrap()                                        Dashboard.vue:51
    └─ Promise.all([dataClient.init(), realtimeHub.init()])          :52
         ├─ DataClient.init()            src/renderer/src/sdk/dataClient.ts:50
         │    └─ acquirePort('query')    src/renderer/src/sdk/portBridge.ts:13
         └─ RealtimeHub.init()           src/renderer/src/sdk/realtimeHub.ts:18
              └─ Promise.all([acquirePort('write'), acquirePort('subscribe')])   :19-22
  ```
- 数据链路：`acquirePort(name)` 对每通道只建连一次（`portPromises` Map 缓存去重，`portBridge.ts:11`）。`dataClient.init` 拿到端口后挂 `port.onmessage → onMessage`（`dataClient.ts:52`）；`realtimeHub.init` 拿到 write/subscribe 两个端口后分别挂 `onmessage` 分发 `backpressure` / `tick` / `ingest`（`realtimeHub.ts:26-34`）。

**步骤 R2：拉库概览 → 初始化视口**

- 代码位置：`Dashboard.vue:56-58`
- 调用栈：
  ```
  dataClient.overview()                       src/renderer/src/sdk/dataClient.ts:147
    └─ query('meta.overview', {})             :97 → 经 query 通道发 {kind:'query', id, op, params}   :120
       （服务端处理见 5.2；meta.overview 走 JSON 内联捷径，src/data-service/query/queryEngine.ts:115-136）
  ```
- 数据链路：返回 `OverviewInfo {totalRows, minTs, maxTs, channels[]}`（`src/shared/types.ts:29-34`）→ 写入 `store.overview`（`src/renderer/src/stores/appStore.ts:14`）；`store.followLive` 为 true 时 `slideToNow(overview.maxTs)`（`appStore.ts:42-45`）把 `range` 视口滑到 `[maxTs-span, maxTs]`。同时 `realtimeHub.onTick` 挂到 `store.metrics`（`Dashboard.vue:53-55`），顶部指标条开始每秒刷新。

**步骤 R3：三组件首次取数**

- `SignalChart.vue:136-140`：`watch([selectedChannelId, range.start, range.end], ..., {immediate:true})` 立即触发 `debouncedLoad()` → 150ms 去抖后进入取数管线（详见第 2 章步骤 W5 起的同一条链路）；
- `BoxplotPanel.vue:158-162`：同样的 immediate watch → `load()`（`BoxplotPanel.vue:47`）并发发 `boxplotByBucket` + `outliers` 两个查询；
- `VirtualTable.vue:77`：`onMounted(reset)` → `loadMore()`（`VirtualTable.vue:36`）发第一页 `signalPage(channelId=null, cursor=null, 500)`。

### 1.4 通道建连细节（三通道共用同一条路径）

以 `query` 通道为例，`write` / `subscribe` 仅通道名不同：

```
渲染主世界                preload 隔离世界              主进程                      数据服务进程
acquirePort('query')                                                                   
  portBridge.ts:13                                                                     
  └ dataBridge.requestPort('query')                                                    
       preload/index.ts:22                                                             
       ├ ipcRenderer.once('data-channel:port:query')  :24（先挂一次性接收）              
       └ ipcRenderer.send('data-channel:request','query')  :27 ──► ipcMain.on(...)    
                                                                   channelBroker.ts:20 
                                                                   ├ new MessageChannelMain()  :25
                                                                   ├ host.postMessage(         
                                                                   │   {type:'data-channel:bind',
                                                                   │    name:'query'}, [port1]) :26 ──► parentPort.on('message')
                                                                   │                              index.ts:71-77
                                                                   │                              └ bindChannel('query', port1)
                                                                   │                                index.ts:119 / :128-131
                                                                   │                                ├ port.start()
                                                                   │                                ├ new QueryEngine(db.instance, port1)
                                                                   │                                └ port.on('message',
                                                                   │                                    e => engine.handleMessage(
                                                                   │                                      unwrapPortMessage(e)))
                                                                   └ event.sender.postMessage(
        window.postMessage(          ◄── 'data-channel:port:query' + [port2]   :27
          {kind:'data-channel:to-renderer',
           name:'query'}, '*', [port])  preload/index.ts:24-26
  window 'message' handler 命中
  portBridge.ts:17-23 → resolve(e.ports[0])
```

- 关键协议常量：`CHANNELS`（`src/shared/protocol.ts:13-17`）、`IPC_EVENTS`（`:21-30`）；
- `unwrapPortMessage()`（`src/data-service/index.ts:175-180`）解包 Electron `MessagePortMain` 的 `{data, ports}` 事件对象——这是必须的坑位处理，否则 `kind` 为 undefined 查询静默失败；
- 建连完成后主进程完全退出数据通路，之后 query/write/subscribe 三通道均为渲染进程 ↔ 数据服务进程直连。

---

## 2. 实时写入刷新——拉模式（DESIGN §10.2）

### 2.0 时序总览

```
Simulator.tick(100ms) → BatchWriter.enqueue → [满 5万行 或 500ms 到] → flush()
  → BEGIN → Appender 逐行 append → COMMIT → onFlush{count,maxTs}
  → broadcast ingest（subscribe 通道）                    → refreshAggregatesThrottled（5s 节流）
渲染端：realtimeHub.onIngest → store.slideToNow(maxTs) → SignalChart watch 命中
  → debouncedLoad(150ms) → pickLayer → dataClient.signalRange → query 通道
  → QueryEngine 流式回帧 → decodeFrame → concatColumns → downsample(Worker) → ECharts setOption
```

### 2.1 步骤 W1：模拟源产批

- 代码位置：`src/data-service/simulator.ts:29` `setInterval(tick, 100)`；`:46` `tick()`
- 调用栈：
  ```
  Simulator.tick()                          simulator.ts:46
    ├─ effectiveRate = throttled ? rate/4 : rate          :48（背压降速点）
    ├─ rowsPerChannel = max(1, (rate/10)/4)               :49（默认 10000 行/s → 每通道 250 行/批）
    └─ 双重循环生成 SignalRow[]：sample(ch, ts)            :52-58
         └─ sample()  :62-71 = 基线 + 正弦 + Box-Muller 高斯噪声（:75-81）+ 0.2% 概率尖峰
  ```
- 数据链路：产出 `SignalRow {ts, channelId, value}` 数组（类型定义 `src/shared/types.ts:16-20`），同批内 `ts = now - (rowsPerChannel - k)` 微错开保持近似有序（zonemap 友好）；默认速率下每批 4 通道 × 250 行 = 1000 行。

### 2.2 步骤 W2：入微批队列（含背压分支）

- 代码位置：`src/data-service/write/batchWriter.ts:38` `enqueue(rows)`
- 调用栈与数据链路：
  ```
  writer.enqueue(rows)                      batchWriter.ts:38
    ├─ queue.push(rows); bufferedRows += n                :40-41
    ├─ level = queueLevel = bufferedRows / 2_000_000      :42, :47-49
    ├─ level > 0.8 → onBackpressure(level)                :43
    │     └─ Simulator.onBackpressure → throttled = true  simulator.ts:42-44（下批起 1/4 速率）
    └─ bufferedRows >= 50_000 → void flush()              :44（行数触发）
  ```
- 另一条触发路径：`batchWriter.ts:27-29` 的 `flushMs=500ms` 定时器，队列非空即 flush（时间触发）。两者先到先触发；阈值定义在 `src/data-service/config.ts:14-15`。
- 外部写入路径（预留）：渲染端 `realtimeHub.writeRows()`（`src/renderer/src/sdk/realtimeHub.ts:48`）发 `{kind:'write.rows', rows:[ts,channelId,value][]}`（协议 `src/shared/protocol.ts:108-111`）→ 数据服务 `bindChannel` WRITE 分支（`src/data-service/index.ts:133-149`）→ 同样进 `batchWriter.enqueue`，且水位 >0.8 时经写入通道回传 `{kind:'backpressure', level}`（`:139-143`）。

### 2.3 步骤 W3：微批事务提交

- 代码位置：`src/data-service/write/batchWriter.ts:58` `flush()`
- 调用栈与数据链路：
  ```
  flush()                                   batchWriter.ts:58
    ├─ flushing 防重入；queue.splice(0) 整体取出           :59-62
    ├─ writer.run('BEGIN TRANSACTION')                    :67（走全局唯一写连接）
    ├─ createAppender('signals')                          :68
    │    └─ 逐行 appendBigInt(ts)/appendInteger(channelId)/appendDouble(value)/endRow()  :72-75
    │       （Appender 直写存储层，绕过 SQL 解析）
    ├─ appender.closeSync(); writer.run('COMMIT')         :80-81
    ├─ writtenTotal += count                              :83（每秒 tick 取数）
    ├─ onFlush?.({count, maxTs})                          :85 → 见步骤 W4
    └─ refreshAggregatesThrottled(maxTs)                  :87 → 见步骤 W4b
  失败分支：ROLLBACK（:89）→ 批次 unshift 回队（:91-92），下轮重试（至少一次语义）
  ```
- 数据落点：`data/hot/hot.duckdb` 的 `signals(ts BIGINT, channel_id INTEGER, value DOUBLE)` 表。

### 2.4 步骤 W4：广播 ingest 增量通知

- 代码位置：`src/data-service/index.ts:66-68` onFlush 回调 → `:160` `broadcast()`
- 数据链路：`{kind:'ingest', maxTs, count}`（`IngestMsg`，`src/shared/protocol.ts:148-152`）经 subscribe 通道 port 结构化克隆推给所有订阅者。数据量极小（两个标量），与查询大数据完全隔离。

### 2.5 步骤 W4b：预聚合增量刷新（5s 节流支线）

- 代码位置：`src/data-service/write/batchWriter.ts:103` `refreshAggregatesThrottled(latestTs)`
- 数据链路：距上次刷新 ≥ `aggregateRefreshMs=5000`（`config.ts:23`）才执行；L1 回退 1 小时（`:108`）、L2 回退 1 天（`:119`），先 `DELETE` 受影响桶再 `INSERT ... SELECT` 按热表重算（`:109-127`），覆盖正在写入的"半桶"。全部走唯一写连接，与微批提交串行。

### 2.6 步骤 W5：渲染端消费 ingest（拉模式）

- 代码位置：`src/renderer/src/components/SignalChart.vue:143-145`
- 调用栈：
  ```
  subscribePort.onmessage                   realtimeHub.ts:30-34（kind==='ingest' → onIngest）
    └─ SignalChart onMounted 中挂的回调：realtimeHub.onIngest = msg => ...   SignalChart.vue:143
         └─ store.followLive && store.slideToNow(msg.maxTs)                  :144
              └─ appStore.slideToNow：range = {start: maxTs-span, end: maxTs}  appStore.ts:42-45
                   └─ watch([selectedChannelId, range.start, range.end]) 命中  SignalChart.vue:136-140
                        └─ debouncedLoad()  SignalChart.vue:86 → debounce(load,150)  utils/debounce.ts:5
  ```
- 数据链路：ingest 消息只携带 `maxTs/count`，**不推数据**——视口滑动改变 `store.range`，由 watch 触发重新取数，即"拉模式"。

### 2.7 步骤 W6：视口取数（查询上行）

- 代码位置：`src/renderer/src/components/SignalChart.vue:39` `load()`
- 调用栈：
  ```
  load()                                    SignalChart.vue:39
    ├─ pickLayer(store.span)                :44 → :30-34
    │    span>14d→'L2' / >2d→'L1' / 否则→'L0'
    └─ dataClient.signalRange(channelId, range, layer, 'signal-chart')   :45-50
         └─ DataClient.query('signal.range', {channelId,start,end,layer},
                              {slot:'signal-chart', cacheKey:'range:...'})   dataClient.ts:151-157
              ├─ LRU 命中直接返回           :98-106（容量 32）
              ├─ 同 slot 旧查询 → cancel(prev)：发 {kind:'cancel', id}     :110-113, :138-141
              ├─ id = nextId++；pending.set(id, ...)                       :115-118
              └─ port.postMessage({kind:'query', id, op, params})          :120
  ```
- 数据链路：query 通道上行消息 `QueryRequestMsg`（`src/shared/protocol.ts:37-42`）；`slot:'signal-chart'` 保证连续拖动时同槽位只有最新查询存活。

### 2.8 步骤 W7：数据服务执行查询（下行流式回帧）

- 代码位置：`src/data-service/query/queryEngine.ts`
- 调用栈与数据链路：
  ```
  port.on('message') → unwrapPortMessage → QueryEngine.handleMessage   index.ts:130 → queryEngine.ts:44
    └─ execute(req)                              queryEngine.ts:69
         ├─ conn = instance.connect()            :71（每查询独占连接）
         ├─ state = { conn, cancelled:false, credit:4, creditWaiter:null }   :72
         ├─ buildQuery('signal.range', params)   :80 → sql.ts:21-32
         │    L0: SELECT ts, value FROM unified WHERE channel_id=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts LIMIT 5000000
         │    L1/L2: 改查 signals_l1/signals_l2，value 列换成 avg_v
         ├─ result = await conn.stream(sql, params)      :81（流式执行）
         ├─ post({kind:'meta', id, format:'cols-bin'})   :82（StreamMetaMsg，protocol.ts:71-77）
         ├─ FrameAccumulator(result.columnCount, typeOf, nameOf)   :86-89 / :165
         │    INTEGER→I32，其余→F64；getColumns() 列主序值数组，null 归零（:181-193）
         ├─ for await (chunk of result)          :91（DuckDB 原生 chunk ~2048 行）
         │    └─ 攒满 frameRows=65536 行 → sendFrame()   :94-96 → :138
         │         ├─ credit<=0 → 挂起等 {kind:'credit'} 回补   :140-144（背压）
         │         ├─ credit--                                  :146
         │         ├─ buffer = acc.drainFrame() → encodeFrame   :147 → :195-205
         │         │    （列式帧编码：src/shared/columnar.ts:53-95，COL1 头 + 列数据段）
         │         └─ port.postMessage({kind:'chunk', id, buffer})   :148-152
         │              （此跳为结构化克隆，transfer 只接受端口对象——见 :149-151 注释）
         ├─ 残余行补发一帧                        :98
         └─ post({kind:'end', id, rowCount, elapsedMs})  :100（StreamEndMsg，protocol.ts:86-91）
  finally: active.delete(id); conn.closeSync()   :109-110
  ```
- 取消分支（slot 抢占时）：`handleMessage` 收到 `{kind:'cancel'}` → `q.conn.interrupt()`（`queryEngine.ts:45-52`）→ 流迭代抛错 → 回 `{kind:'error', cancelled:true}`（`:101-107`）。

### 2.9 步骤 W8：SDK 组帧（渲染进程内零拷贝起点）

- 代码位置：`src/renderer/src/sdk/dataClient.ts:64` `onMessage`
- 数据链路：
  ```
  'chunk' → decodeFrame(msg.buffer)              dataClient.ts:71-73
             └─ columnar.ts:98-126：在帧 buffer 上直接建 Float64Array/Int32Array 视图（零拷贝）
          → 立即回补 {kind:'credit', id, chunks:1}  dataClient.ts:75
  'end'   → concatColumns(frames)                 dataClient.ts:78-85
             └─ columnar.ts:129-148：多帧拼成连续列（一次拷贝），得 Map<'ts'|'value', Float64Array>
          → resolve({columns, rowCount, elapsedMs})
  ```
- 迟到帧（已取消/超时查询）直接丢弃（`dataClient.ts:66`）。

### 2.10 步骤 W9：Worker 降采样 + 上屏

- 代码位置：`src/renderer/src/components/SignalChart.vue:62-74`
- 调用栈与数据链路：
  ```
  load()（续）
    ├─ ts/value = res.columns.get(...)                    SignalChart.vue:51-52（Float64Array 视图）
    ├─ target = max(200, 容器像素宽 × 2)                   :62-63
    ├─ downsample(ts, value, target)                      :64
    │    └─ downsampleService.ts:23-33
    │         └─ WorkerPool.exec({kind:'downsample',x,y,threshold}, [x.buffer,y.buffer])  :29
    │              └─ workerPool.ts:56 exec → :70 dispatch → worker.postMessage(msg, transfer)  :77
    │                   （Transferable 转移，x/y 原 buffer 此后失效）
    │                   └─ lttb.worker.ts:105 self.onmessage
    │                        ├─ 超阈值 8 倍 → minMaxPreselect(x,y,threshold*4)   :107-108 → :30-60
    │                        ├─ lttb(px,py,threshold)                            :109 → :63-103
    │                        └─ postMessage({sx,sy}, [sx.buffer,sy.buffer])      :112（Transferable 回传）
    ├─ pairs[i] = [sx[i], sy[i]]                          SignalChart.vue:67-68（≤数千点，开销可忽略）
    ├─ applyingZoom = true                                :71（防 setOption 再触发 datazoom 的循环）
    └─ toRaw(chart).setOption(buildOption(pairs), {lazyUpdate:true})   :72 → buildOption :88-109
         （animation:false / sampling:'lttb' / large:true / progressive:4000）
  ```
- 面板信息条更新：`N 行 → M 点 · Lx 层 · SQL xxms`（`:74`）。

---

## 3. 归档（DESIGN §10.3）

### 3.0 时序总览

```
定时器(10min/首15s) → archiveBefore(watermark = now - 3天)
  → ① ThreadPool.run({type:'archive-copy'}) → worker 线程 COPY → archive/dt=YYYY-MM-DD/*.parquet
  → ② 补算被删区间 L1/L2 桶 → ③ DELETE 热表旧区间 → ④ ensureUnifiedView 刷新
  → 后续 L0 查询经 unified 自动穿透 Parquet（dt 目录即分区裁剪）
```

### 3.1 步骤 A1：巡检触发

- 代码位置：`src/data-service/index.ts:100-110`
- 调用栈：
  ```
  setInterval(runArchive, config.archiveIntervalMs /*10min*/)   :109
  setTimeout(runArchive, 15_000)                                :110（启动后先巡检一次）
  runArchive()                                                  :100-108
    └─ watermark = Date.now() - config.hotRetentionMs /*3天*/   :102（阈值 config.ts:19）
    └─ archiveBefore(pool, db.writer, db.dbPath, db.archiveDir, watermark)   :103
  ```

### 3.2 步骤 A2：归档管线四步

- 代码位置：`src/data-service/db/archive.ts:17` `archiveBefore()`

**① 空转检查 + 线程池导出**

```
archiveBefore()                                 archive.ts:17
  ├─ SELECT count(*) FROM signals WHERE ts < $1 → rows=0 直接返回   :25-27
  └─ pool.run<void>({type:'archive-copy', dbPath, archiveDir, watermarkTs})   :30-35
       └─ ThreadPool.run()                        threadPool.ts:41（入队 + 10min 超时兜底）
            └─ dispatch()                         threadPool.ts:63
                 └─ idle.pop() ?? spawnIfBelowCapacity()   :65 → new Worker(scriptPath,
                        { resourceLimits:{ maxOldGenerationSizeMb:512 } })   :73-78
                 └─ worker.postMessage({id, task})          :69
                      └─ threadTask.worker.ts:23 parentPort.on('message')
                           └─ execute(task)                 :36
                                └─ 'archive-copy' 分支      :38-57
                                     ├─ DuckDBInstance.fromCache(dbPath)   :39（进程内单实例缓存，
                                     │    与主线程写连接共享库文件、互不阻塞）
                                     ├─ instance.connect()                  :40
                                     └─ conn.run(COPY (SELECT ts,channel_id,value,
                                          strftime(epoch_ms(ts),'%Y-%m-%d') AS dt
                                          FROM signals WHERE ts < $1)
                                          TO '<archiveDir>' (FORMAT PARQUET,
                                          PARTITION_BY (dt), OVERWRITE_OR_IGNORE))   :45-52
```

- 数据链路：产出 `data/archive/dt=YYYY-MM-DD/*.parquet` 目录树（Hive 分区）；任务回包 `{id, ok:true, result}` → `threadPool.ts:79-89` resolve 并归池复用。

**② 预聚合水位补算**

- 代码位置：`archive.ts:38-51`
- 数据链路：对 `ts < watermark` 区间先 `DELETE FROM signals_l1/signals_l2` 再按热表 `INSERT ... SELECT` 重算（L1 分钟桶 / L2 小时桶）。必须在删热表前完成——L1/L2 只从热表派生。全部走唯一写连接 `writer`。

**③ 删除热表旧区间**

- 代码位置：`archive.ts:54`
- 数据链路：`DELETE FROM signals WHERE ts < $1`（唯一写连接），热表体积恒定。

**④ 刷新统一视图**

- 代码位置：`archive.ts:57` → `src/data-service/db/schema.ts:30` `ensureUnifiedView()`
- 数据链路：`containsParquet(archiveDir)`（`schema.ts:42-53`）检测到归档文件后，`unified` 视图重建为 `signals UNION ALL read_parquet('<archiveDir>/**/*.parquet', hive_partitioning=true)`（`schema.ts:33-39`，Windows 路径经 `toGlobPath` 转 POSIX 分隔符 `:56-58`）。
- 此后 `signal.range` L0 与 `signal.page` 等所有打 `unified` 的查询（`src/data-service/query/sql.ts:24,38`）自动穿透热表 + Parquet；`dt=YYYY-MM-DD/` 目录树让文件系统充当分区过滤器。

---

## 4. 箱线联动下钻（DESIGN §10.4）

### 4.0 时序总览

```
前置：BoxplotPanel.load() → boxplotByBucket + outliers（SQL 下推五数/越界点）→ 箱线图
用户交互：brush 框选 或 点击箱体
  → 类目下标 → currentBucketStarts[]/currentBucketMs 换算绝对时间范围
  → store.setRange（followLive=false）→ SignalChart watch 命中
  → pickLayer（新跨度选更细的层）→ 第 2 章 W6–W9 同一条取数管线 → 曲线呈现该区间原始形态
```

### 4.1 前置步骤 B0：箱线数据加载

- 代码位置：`src/renderer/src/components/BoxplotPanel.vue:47` `load()`
- 调用栈与数据链路：
  ```
  load()                                      BoxplotPanel.vue:47
    ├─ currentBucketMs = pickBucketMs(store.span)   :52 → :31-39（跨度/40 对齐候选桶宽 1s~7天）
    ├─ Promise.all([
    │    dataClient.boxplotByBucket(ch, range, bucketMs, 'boxplot')   :54
    │      → query('stats.boxplot', {channelId,start,end,bucketMs})   dataClient.ts:163-169
    │      → sql.ts:51-62：一条 SQL 按时间桶 GROUP BY 产出全部箱体
    │        SELECT (ts//$4)*$4 AS gk, min/low, approx_quantile q1/median/q3, max/high, count(*)
    │    dataClient.outliers(ch, range, 500)                          :56
    │      → query('stats.outliers', {...,maxPoints:500})             dataClient.ts:171-173
    │      → sql.ts:76-90：CTE 算 Q1/Q3 → 1.5×IQR 越界点 (ts,value)，LIMIT 500
    │  ])
    ├─ 组装：categories[i] = fmtTime(gk[i])；boxData[i] = [low,q1,median,q3,high]   :66-74
    │    currentBucketStarts = Array.from(gk)                          :75（brush 换算的关键状态）
    │    bucketStartToIndex: Map<桶起点, 类目下标>                      :68, :73
    ├─ 异常散点：bucketStart = floor(ts/bucketMs)*bucketMs → 贴到所属箱体类目   :78-85
    └─ toRaw(chart).setOption(buildOption(...), {notMerge:true})      :87-90
  ```
- 下行数据形态：两个查询都走第 2 章 W7–W8 的 meta→chunk→end 流，结果为列式帧解码出的 `gk/low/q1/median/q3/high`（F64）与 `ts/value`（F64）TypedArray。

### 4.2 步骤 B1：用户框选（brush 路径）

- 代码位置：`src/renderer/src/components/BoxplotPanel.vue:140-156`
- 调用栈与数据链路：
  ```
  c.on('brushSelected', e)                      BoxplotPanel.vue:140
    ├─ indexes = e.batch[0].selected[0].dataIndex ?? []        :144（被选箱体的类目下标数组）
    ├─ minIdx / maxIdx = Math.min/max(...indexes)              :146-147
    ├─ store.setRange({                                        :150-153
    │     start: currentBucketStarts[minIdx],                  ← 类目下标 → 桶绝对起点（epoch ms）
    │     end:   currentBucketStarts[maxIdx] + currentBucketMs ← 末桶右开边界
    │   })
    │     └─ appStore.setRange：followLive=false；range={...}   appStore.ts:37-40
    └─ c.dispatchAction({type:'brush', areas:[]})              :155（清除刷选框）
  ```

### 4.3 步骤 B1'：用户点击单箱体（click 路径）

- 代码位置：`src/renderer/src/components/BoxplotPanel.vue:133-137` → `:166` `drillInto(index)`
- 数据链路：`p.dataIndex`（类目下标）→ `store.setRange({start: currentBucketStarts[index], end: + currentBucketMs})`（`:168-171`）——即下钻到该箱体对应的单个时间桶。

### 4.4 步骤 B2：联动 SignalChart 穿透更细的层

- 代码位置：`src/renderer/src/components/SignalChart.vue:136-140` watch → `:39` `load()`
- 调用栈：
  ```
  store.range 变化
    └─ SignalChart watch([selectedChannelId, range.start, range.end])   :136-140
         └─ debouncedLoad()（150ms 去抖，utils/debounce.ts:5）
              └─ load()                                SignalChart.vue:39
                   └─ pickLayer(store.span)            :44 → :30-34
   典型下钻效果：框选前 span 为数天 → L1；框选后 span 缩到数分钟/数小时 → L0
                   └─ dataClient.signalRange(..., layer, 'signal-chart')   :45
                        └─（此后完全复用第 2 章 W6→W9：
                            query 通道上行 → QueryEngine 流式回帧 → decodeFrame/concatColumns
                            → Worker MinMax→LTTB → ECharts setOption）
  ```
- 同时 `BoxplotPanel` 自身的同名 watch（`BoxplotPanel.vue:158-162`）也被触发，箱线图按新视口重算桶宽并重载——两个面板始终共用 `store.range` 这一单一时间视口状态。

---

## 5. 附：公共链路索引

### 5.1 三条通道与消息流向速查

| 通道 | 建立路径 | 上行（渲染→DS） | 下行（DS→渲染） | 协议定义 |
|---|---|---|---|---|
| `query` | §1.4 | `query` / `cancel` / `credit` | `meta` / `chunk` / `end` / `error` | `src/shared/protocol.ts:37-101` |
| `write` | §1.4 | `write.rows` / `sim.control` | `backpressure` | `src/shared/protocol.ts:108-130` |
| `subscribe` | §1.4 | —（单向） | `tick` / `ingest` | `src/shared/protocol.ts:137-154` |

通道绑定分发：`src/data-service/index.ts:119-158` `bindChannel()`；背压回传：`src/data-service/index.ts:139-143`。

### 5.2 meta.overview 的 JSON 捷径

唯一不走列式帧的查询：`queryEngine.ts:75-78` 拦截 → `executeOverview()`（`:115-136`）——
`SELECT count(*)/min(ts)/max(ts) FROM unified` + `SELECT id,name FROM channels`，
`{kind:'meta', format:'json', payload: OverviewInfo}` 内联后直接 `{kind:'end'}`；
渲染端 `dataClient.ts:68-69` 收进 `p.json`，`:147-149` `overview()` 取出。

### 5.3 关键拷贝/零拷贝边界

| 跳 | 位置 | 机制 |
|---|---|---|
| DS → 渲染（chunk） | `queryEngine.ts:148-152` | 结构化克隆（Electron `MessagePortMain` transfer 仅接受端口对象）；~64k 行大帧摊薄 |
| 渲染端解码 | `dataClient.ts:73` → `columnar.ts:98` | 帧 buffer 上建 TypedArray 视图，零拷贝 |
| 渲染 → Worker | `downsampleService.ts:29-32` → `workerPool.ts:77` | Transferable 转移（双向），O(1) |
| 帧拼接 | `dataClient.ts:81` → `columnar.ts:129` | `concatColumns` 一次拷贝（仅 end 时按需） |

### 5.4 重启自愈链路（与 §1 启动复用同一路径）

```
DS 进程 rss > 2048MB（每秒 tick 上报，index.ts:96 → dataServiceHost.ts:89-91 缓存）
  → 主进程 60s 巡检 checkMemoryAndRecycle()        dataServiceHost.ts:46-54
  → gracefulRestart()：postMessage('shutdown') → 10s 超时强杀 → spawn() → onRestarted?.()   :56-75
  → main/index.ts:38-40 → webContents.send('data-service:restarted')
  → preload/index.ts:29-31 转发 → portBridge.ts:37-42 resetPorts()
  → Dashboard.vue:65-70：dataClient.reset()（拒绝悬挂 Promise，dataClient.ts:56-62）
    + realtimeHub.reset()（:37-40）→ bootstrap() 重新建连 + 拉概览（§1.3 全路径复用）
```
