# 调试实录：WebSocket 消息全部被丢弃（进度始终 1%）

> 项目：image-studio · 时间：2026-10-31 · 相关模块：`src/comfy/client.ts`
> 这是一个典型的"测试全绿、生产全坏"案例，根因只有一行代码，
> 但定位过程值得沉淀。

---

## 一、现象

- 生成过程中任务进度**始终停在 1%**，直到完成直接跳到 100%
- 任务最终状态正确（succeeded），出图正常
- 单元测试 124 个全部通过，覆盖率 97%

## 二、排查过程

### 第 1 步：确认问题在哪一层

进度链路有三段，先分段验证：

```
ComfyUI --WS事件--> ComfyClient.listen --onEvent--> GenerationService --updateJob--> SQLite
```

用一个独立脚本直接调 `ComfyClient`（绕过服务层与数据库），提交 6 步
工作流并记录 `onEvent` 收到的全部事件：

```typescript
const events: string[] = [];
const pid = await client.submit(wf, "dbg-ts-client");
const r = await client.listen("dbg-ts-client", pid, (ev) => events.push(ev.type), 60000);
console.log(r, events);
// 输出：{ ok: true }  事件: （空！）
```

**结论：客户端一个事件都没收到，问题在 WS 层**；而 `ok: true` 说明
任务完成判定来自 history 轮询兜底——这解释了"能完成但没进度"。

> 注：任务能成功、出图正常，恰恰掩盖了 bug——兜底机制让错误路径
> 产生了正确结果。这是排查时的第一个干扰项。

### 第 2 步：裸 ws 库连接测试

排除网络/ComfyUI 侧问题，直接用 `ws` 库连接：

```typescript
const ws = new WebSocket("ws://127.0.0.1:8188/ws?clientId=dbg-raw");
ws.on("message", (data, isBinary) => console.log(isBinary ? "<binary>" : data.toString()));
// 输出：正常收到 {"type":"status",...} JSON
```

**结论：连接与事件推送本身没问题**，嫌疑收窄到我们的封装层。

### 第 3 步：逐层测封装

先测 `defaultWsFactory()`（构造函数适配层）——正常，能收到 JSON。
再回到 `listen()` 内部的事件处理代码：

```typescript
socket.on("message", (raw: unknown) => {
  if (Buffer.isBuffer(raw)) return; // ← 问题就在这行
  ...
});
```

### 第 4 步：验证根因

查 `ws` 库文档确认：**message 事件的 `data` 对 text 帧同样以
`Buffer` 交付**，文本与二进制的区分靠第二个参数 `isBinary`，
而不是数据类型。也就是说：

| 帧 | data 类型 | isBinary |
|:---|:---|:---|
| JSON 事件（progress 等） | `Buffer` | `false` |
| 预览图二进制帧 | `Buffer` | `true` |

`Buffer.isBuffer(raw)` 对**两者都返回 true**——所有 JSON 事件被
当成预览图丢弃。

裸测试里 `data.toString()` 能打出 JSON，正是因为 text 帧的 data
就是 Buffer（toString 后是文本）。当时看到打印正常就没多想，
错过了第二参数——这是排查时的第二个干扰项。

## 三、修复

```diff
- socket.on("message", (raw: unknown) => {
-   if (Buffer.isBuffer(raw)) return; // 预览图二进制帧，忽略
-   const ev = (typeof raw === "string" ? JSON.parse(raw) : raw) as WsEvent;
+ socket.on("message", (raw: unknown, isBinary = false) => {
+   if (isBinary) return; // 二进制帧才忽略
+   const text = typeof raw === "string" ? raw
+     : Buffer.isBuffer(raw) ? raw.toString("utf8")
+     : JSON.stringify(raw);              // 测试假帧（对象）直接序列化
+   const ev = JSON.parse(text) as WsEvent;
```

测试同步修正：假 WS 的二进制帧用例从 `cb(Buffer.from([1,2]))`
改为 `cb(Buffer.from([1,2]), true)`——**模拟层必须还原真实语义**。

修复后实测（12 步生成，事件流完整）：

```
progress 1/12 … progress 12/12 → executed → execution_success
```

端到端轮询数据库进度轨迹：`1 → 10 → 18 → … → 98 → 100`。

## 四、经验总结

1. **`ws` 库的帧类型语义**：text/binary 都交付 Buffer，用第二个参数
   `isBinary` 区分。任何基于数据类型的判断（`Buffer.isBuffer`、
   `typeof === "string"`）都会出错。这类"与直觉相反的 API 语义"
   是跨语言移植（Python websocket-client 直接给 str/bytes，天然
   可用类型区分）时最容易踩的坑。

2. **兜底机制会掩盖 bug**：history 轮询让"事件全丢"表现出"功能正常
   只是没进度"。兜底是好事，但排查"某个数据源不工作"类问题时，
   要先确认数据**本来的主路径**是否通畅——本次第一步直接测
   ComfyClient 就是这个思路。

3. **模拟层必须忠实于真实语义**：假 WS 传字符串帧，所以单测里
   `typeof raw === "string"` 永远为真，测试全绿。一旦模拟层的
   行为与真实库有出入，为它写的代码就只在测试里成立。
   修 bug 时除了改产品代码，还要回头修模拟层，让测试能覆盖住
   真实的坑。

4. **分层定位法**：现象 → 直测最底层客户端（排除上层）→ 裸库对照
   （排除封装）→ 逐层夹逼。本次四步收敛，每步都有明确结论。

5. **调试脚本即文档**：`tmp-dbg/*.mts` 这类临时脚本用完即删，
   但关键结论应沉淀成文档（本文），尤其是 API 语义陷阱——
   下次有人（包括自己）复制这段客户端代码时能直接避开。
