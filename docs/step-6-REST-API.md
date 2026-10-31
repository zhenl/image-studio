# Step 6 · REST API：生成、任务、估算、图库与 SSE

对应分支 `step-6-api`。本步骤把服务能力通过 HTTP 暴露出来，
接口契约与 qwenimage-studio 对齐（前端可近乎原样移植）。

## 完成内容

| 端点 | 方法 | 说明 |
|:---|:---|:---|
| `/api/v1/generate` | POST | 同步出图（阻塞到完成，受 `INFER_TIMEOUT_SECONDS` 保护） |
| `/api/v1/jobs` | POST/GET | 异步入队（202 + 排队位置）/ 任务列表 |
| `/api/v1/jobs/:id` | GET/DELETE | 任务详情 / 取消并删除 |
| `/api/v1/jobs/:id/events` | GET | SSE 进度流（progress/image/done/error） |
| `/api/v1/preview` | POST | 耗时/显存估算 + 警告（含校准状态） |
| `/api/v1/gallery` | GET | 图库列表（`?favorite=1` 收藏过滤） |
| `/api/v1/gallery/:id/favorite` | POST | 收藏切换 |
| `/api/v1/status` | GET | ping ComfyUI + GPU 信息 + 队列状态 |
| `/data/*` | GET | 产物静态服务（带路径穿越防护） |

## 关键技术

### 上下文装配（src/context.ts）

`buildContext(overrides)` 集中装配 Store/Bus/Scheduler/引擎/校准器，
**全部可注入**——API 测试用临时目录 + 假引擎 + 假 ComfyUI 构建一个
完整上下文，再 `buildApp(ctx)` 拿到应用实例。这相当于 Python 版
"每个模块 import 全局单例"的可测试翻版。

装配中有一个 TS 特有的循环引用：generation 依赖 scheduler 的取消
回调、scheduler 依赖 generation 作为 worker。用 `let scheduler:
Scheduler` 先声明后赋值 + 显式类型标注解决（TS7022 的标准解法）。

### zod 请求校验（对应 pydantic）

`generateRequestSchema` 一处定义：约束（宽高 64 倍数、参考图 ≤9、
批量 ≤ MAX_BATCH）、默认值（`.default()`）、派生（`.transform()` 里
`count = batch_size`——Step 6 修复过的"生成张数不生效" bug 在这里
从 schema 层就保证了一致）。校验失败统一 422 + 首条错误信息。

### SSE 的 Fastify 写法

Python 版用 StreamingResponse + asyncio；Fastify 里直接写原生
`reply.raw`：

```typescript
reply.raw.writeHead(200, { "Content-Type": "text/event-stream", ... });
const off = bus.subscribe(id, (ev) => reply.raw.write(`event: ...`));
req.raw.on("close", off);   // 浏览器断开时退订，防泄漏
```

两个细节：任务已终结时立即补发 done 并结束（前端重连场景）；
`close` 事件退订是必须的，否则 EventSource 重连会累积监听器。

### 估算接口带校准语义

返回 `calibrated` / `samples`，未校准时警告里明确提示"完成首次
生成后会自动校准"——与 qwenimage-studio 改进后的行为一致。
测试里用 `calibrator.invalidate()` 绕过 30s 缓存验证两个分支。

### 静态产物服务

图片 URL 统一为 `/data/<相对路径>`（生成服务入库时生成）。
安全要点：`path.resolve` 后必须 `startsWith(root)` 校验，
否则 `/data/../../etc/passwd` 直接穿越——测试里专门有越权用例。

## 测试

- 105 用例全过，覆盖率 98.23%（branches 88.62%）
- API 层 13 场景：同步/异步/批量种子、422 三种非法参数、
  SSE 已完成任务补发、静态服务 200/403/404、状态 ping
- 测试顺序教训：估算"未校准→已校准"依赖执行顺序，
  把 preview 用例移到 generate 之前（状态依赖要在测试设计时显式管理）
