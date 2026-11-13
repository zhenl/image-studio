# Step 2 · ComfyUI 客户端：HTTP + WebSocket 的完整封装

对应分支 `step-2-comfy-client`。本步骤实现应用端与 ComfyUI 的全部
交互通道，是「前后端分离架构」中应用端唯一的推理依赖。

## 完成内容

`src/comfy/client.ts` 的 `ComfyClient`：

| 方法 | 端点/通道 | 用途 |
|:---|:---|:---|
| `ping()` | `GET /system_stats` | 连接健康检查（状态徽章） |
| `systemStats()` | `GET /system_stats` | GPU 名称、显存（设备信息展示） |
| `submit(workflow, clientId)` | `POST /prompt` | 提交 API 格式工作流；`node_errors` 非空即抛 `NODE_ERRORS` |
| `history(promptId)` | `GET /history/{id}` | 结果查询——WS 偶发丢帧时的兜底 |
| `viewImage(img)` | `GET /view` | 按文件名取回产物二进制 |
| `uploadImage(buf, name)` | `POST /upload/image` | 上传参考图，返回 ComfyUI 侧文件名 |
| `listen(clientId, promptId, onEvent, timeout)` | `ws://…/ws?clientId=` | 监听进度事件直到完成/失败/超时 |
| `listNodeFiles(nodes, field)` | `GET /object_info/{node}` | 模型管理：ComfyUI 实际可见的模型列表 |

错误统一为 `ComfyError`，带 `code`（`UNREACHABLE` / `NODE_ERRORS` /
`TIMEOUT` / `EXECUTION_ERROR` / `NO_OUTPUT`），上层可按 code 决定
重试或直接展示。

## 关键技术

### 依赖注入获得可测试性

Python 版用 urllib/websocket-client 直连，测试要么起真 ComfyUI
要么跳过。TS 版把 **fetch 实现与 WebSocket 工厂做成构造参数**：

```typescript
new ComfyClient({ baseUrl, fetchImpl, wsFactory });
```

- 生产：默认 `fetch` + `ws` 库
- 测试：假 fetch 返回构造好的 `Response`；假 WS 按 script 逐帧派发事件

于是 ComfyUI 协议的**每个分支**（成功/node_errors/网络错误/超时/
丢帧兜底/二进制帧忽略/字符串帧解析）都有单测，不需要任何真实服务。

### WS 监听的可靠性设计

1. **超时保护**：`listen` 自带定时器，到点 close 并返回超时——
   对应 Python 版「引擎侧超时要略早于路由层」的实践
2. **history 兜底**：连接非正常关闭时，用 `/history` 校验任务是否
   实际完成（`status.completed`），避免丢帧导致任务永远"进行中"
3. **二进制帧过滤**：ComfyUI 的预览图走 WS 二进制帧，JSON 事件走
   文本帧，`Buffer.isBuffer` 一行分流

### AbortSignal.timeout

Node 18+ 内置的 `AbortSignal.timeout(ms)` 让每个请求自带超时，
不需要手写 timer 清理——比 Python 版手动 `wait_for` 简洁。

## 测试要点（test/comfy-client.test.ts）

- 43 个用例全部通过，`src/` 覆盖率 99.6%（branches 87.5%）
- 假 WS 的三种注入形态：对象帧 / 字符串帧 / 二进制帧
- `listNodeFiles` 验证多节点并集、去重、非字符串项过滤、不可达回退 null

## 与 Python 版对照

经典做法同样是这三步
（提交 → 监听 → 取图），但拆在多个文件且依赖真实连接做集成验证；
TS 版一个类 + 注入，全部行为可在毫秒级单测里复现。
