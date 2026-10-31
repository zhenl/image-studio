# Step 4 · 任务队列、SQLite 存储与事件总线

对应分支 `step-4-queue-db`。生成是长任务（分钟级），必须异步化——
本步骤搭好「队列 + 调度 + 存储 + 事件推送」的骨架，引擎尚用假 worker。

## 完成内容

| 模块 | 职责 |
|:---|:---|
| `src/db/store.ts` | better-sqlite3：jobs / images 两表 + 仓储函数（含耗时校准查询） |
| `src/queue/scheduler.ts` | 串行调度器：入队上限、串行消费、失败落库、取消（排队/运行中两种语义） |
| `src/events/bus.ts` | 应用内 EventBus：生成流程 publish，SSE 路由 subscribe |

## 关键技术

### better-sqlite3 的同步 API 是优势

Python 的 sqlite3 也是同步的，但在 asyncio 里要小心阻塞事件循环；
Node 侧 better-sqlite3 的同步调用在单线程事件循环里同样"阻塞"，
但我们的写操作都是毫秒级单行 UPDATE/INSERT，直接调用反而免去了
`run_in_executor` 的桥接成本。事务/预编译语句开箱即用。

表结构与 Python 版对齐：jobs（参数快照 params_json、状态机、进度）、
images（尺寸/步数/种子/elapsed_ms——既是图库元数据，
也是 Step 5 耗时自校准的数据源）。大字段（参考图 base64）同样
不进数据库，走参数快照时剥离。

### 串行调度器的设计

GPU 任务并行没有意义（显存互相挤占），ComfyUI 侧也串行执行：

```typescript
submit(jobId, params)  // 队满抛错；pump() 立即尝试消费
  └─ pump(): running? return : shift → status=running → worker()
       └─ finally: running=null; 还有排队 → 继续 pump
```

- **失败也走 finally**：worker 抛错标记 failed + 发布 error 事件，
  但队列继续消费，一个坏任务不阻塞后面
- **取消的两种语义**：排队中的直接出队标记 canceled；
  运行中的只置 cancel 标记（`isCancelRequested`），由 worker
  在合适的检查点响应——对应 Python 版"共享模式下不能全局 /interrupt"的实践

### 位置语义的坑（写测试抓出来的）

`submit` 返回排队位置。初版在 `pump()` 之后读 `queue.length`，
但 pump 同步 shift 了队首 → 永远返回 0。测试断言 `toBe(1)` 失败
暴露了这个问题，修正为先记位置再触发 pump——**这正是"返回值有
明确语义 + 断言精确值"的价值**。

### EventBus 为 SSE 铺路

生成流程与 HTTP 请求生命周期解耦：任务在后台跑，进度事件先发到
进程内总线；Step 6 的 SSE 路由只做 `bus.subscribe(jobId, send)` +
连接关闭时退订。对应 Python 版 `asyncio.run_coroutine_threadsafe`
桥接的简化版——Node 单线程无需跨线程投递。

## 测试

- 75 用例全过，覆盖率 99.81%（branches 91.66%）
- Store：CRUD、状态过滤、收藏、校准查询过滤无效记录
- Scheduler：串行顺序、队满、worker 抛错不阻塞、两种取消、
  事件发布时机（用 `vi.waitFor` 处理异步竞态）
