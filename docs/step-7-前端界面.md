# Step 7 · 前端界面：原生 HTML/JS 单页应用

对应分支 `step-7-frontend`。前端采用轻量技术
选型——**原生 HTML + JS，无构建步骤**——因为后端换语言不影响前端栈；
且生成类应用的交互（表单 + 轮询/订阅）不需要框架复杂度。

## 完成内容

`frontend/index.html` + `frontend/app.js` + `frontend/style.css`（复用
基础样式并增补缺失类）：

- **文生图 / 图生图**双模式切换
- **参考图 3×3 九宫格**：点击/多选上传/拖拽，带序号、可删除、
  `<image1>`~`<image9>` 一键插入
- **参考方式**三选（自动/智能编辑/传统重绘），经典模式显示重绘强度
- **参数区**：尺寸预设、步数、引导系数、生成张数、种子
- **估算条**：调参防抖 260ms 后请求 `/preview`，展示校准状态，
  警告消失逻辑（历史 bug 教训：
  `estimateHadWarning` 标记区分估算警告与表单校验错误）
- **画布 / 图库 / 任务**三个 Tab：出图结果、收藏（★）、任务状态列表
- **双按钮**：开始生成（同步阻塞）/ 后台生成（入队 + SSE 订阅进度）
- **状态徽章**：ping `/status` 显示「ComfyUI 已连接/未连接」+ GPU 信息，
  15 秒自动刷新——对应 Step 8 详述的"用真实 ping 而非引擎内部标志"

## 关键技术

### SSE 订阅（EventSource）

```javascript
const es = new EventSource(`${API}/jobs/${jobId}/events`);
es.addEventListener("progress", (e) => setProgress(JSON.parse(e.data).percent));
es.addEventListener("image",  (e) => appendResult(JSON.parse(e.data).url));
es.addEventListener("done",   () => { es.close(); ... });
```

浏览器原生 `EventSource` 自带断线重连；`done` 事件到达后主动 `close()`
（否则重连会再收到一次 done）。对应 Python 版完全相同的模式。

### 静态文件服务（无 nginx/无构建）

Fastify 直接 `createReadStream` 返回三个文件（index.html / app.js /
style.css），MIME 表手工维护。开发期 `tsx watch` 改后端即重启；
前端改动刷新浏览器即生效——零构建链是刻意选择。

### 前端不进覆盖率统计

`vitest.config.ts` 的 coverage `include` 只有 `src/**/*.ts`。前端逻辑
（防抖、DOM 渲染、SSE 状态机）通过 API 契约间接保证——这是本项目的
明确取舍：编排型应用的核心风险在后端编排与协议层。

## 测试与验证

- 105 用例全过，后端覆盖率 98.05%
- `GET /` 返回完整 HTML（测试断言包含 "Image Studio"）
- `node --check app.js` 语法校验
