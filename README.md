# Image Studio · 本地图片生成器（Node.js + TypeScript）

**qwenimage-studio 的 Node.js + TypeScript 实现**——同样的功能、同样的
前后端分离架构，用于演示：推理下沉到独立 ComfyUI 服务之后，应用端的
技术栈是自由选择的。

`Fastify` · `better-sqlite3` · `sharp` · `zod` · `vitest` · `原生 HTML/JS 前端`

## 功能

- 文生图 / 图生图（传统重绘 + Qwen-Image 2.1 原生多参考图智能编辑）
- 参考图最多 **9 张**（3×3 宫格），`<image1>`~`<image9>` 一键插入
- 同步生成 / 后台队列（SSE 实时进度）
- 生成耗时按本机历史实测**自动校准**
- 模型管理：以 ComfyUI 实际可见列表为准的三类模型选择，即时生效
- 图库（收藏 / 参数记录）、ComfyUI 连接状态徽章
- 单元测试覆盖率 ≥ 90%（112 用例）

## 快速开始

前置：本机有常驻 ComfyUI 服务（参见 [comfy-service](../comfy-service)），
端口 8188，模型 Qwen-Image 2.1（GGUF）。

```bash
npm install
cp .env.example .env    # 按需修改 COMFYUI_URL / 模型文件名
npm start               # http://127.0.0.1:8030
```

开发与测试：

```bash
npm run dev               # tsx watch 热重启
npm run test:coverage     # 覆盖率（lines ≥ 90 / branches ≥ 85 门槛建在配置里）
npm run typecheck         # tsc --noEmit
```

## 架构

```
前端（原生 HTML/JS，无构建）
   │ REST + SSE
▼
Fastify 后端（本仓库）
 ├── routes/       # generate / jobs / preview / gallery / models / status
 ├── workflow/     # ComfyUI 工作流构建（纯函数，三通道）
 ├── comfy/        # ComfyClient：HTTP + WebSocket，fetch/WS 工厂可注入
 ├── queue/        # 串行调度器（取消语义）
 ├── db/           # better-sqlite3：jobs / images
 ├── services/     # 生成编排、参考图预处理（sharp）、耗时自校准
 └── events/       # EventBus → SSE
▼ HTTP + WebSocket（ComfyUI 协议）
常驻 ComfyUI（comfy-service，共享推理服务）
```

## 教程式开发过程

本项目按 8 步递进构建，每步一个分支 + 一篇文档（`docs/`），
`git checkout step-N-*` 可查看任意中间状态：

| 分支 | 内容 | 文档 |
|:---|:---|:---|
| `step-1-scaffold` | TS + Fastify + Vitest 骨架、zod 配置 | [step-1](docs/step-1-项目骨架.md) |
| `step-2-comfy-client` | ComfyUI 客户端（HTTP + WS） | [step-2](docs/step-2-ComfyUI客户端.md) |
| `step-3-workflow` | 工作流构建器（三通道） | [step-3](docs/step-3-工作流构建器.md) |
| `step-4-queue-db` | 队列、SQLite、事件总线 | [step-4](docs/step-4-队列与存储.md) |
| `step-5-generation` | 生成编排、参考图预处理、自校准 | [step-5](docs/step-5-生成服务.md) |
| `step-6-api` | 完整 REST API + SSE | [step-6](docs/step-6-REST-API.md) |
| `step-7-frontend` | 原生前端界面 | [step-7](docs/step-7-前端界面.md) |
| `step-8-model-mgmt` | 模型管理、状态徽章、收尾 | [step-8](docs/step-8-模型管理.md) |

架构总览另见 comfy-service 的
[前后端分离架构指南](../comfy-service/docs/前后端分离架构指南.md)。

## 与 qwenimage-studio（Python）的对照

| 模块 | Python 版 | 本项目 |
|:---|:---|:---|
| Web 框架 | FastAPI | Fastify |
| 校验 | pydantic | zod |
| ComfyUI 客户端 | urllib + websocket-client | fetch + ws（工厂可注入） |
| 数据库 | sqlite3 | better-sqlite3 |
| 图像处理 | Pillow | sharp |
| 配置 | pydantic-settings | zod + dotenv（可注入） |
| 测试 | pytest（依赖真实服务集成） | vitest（全量假实现，毫秒级） |

## 许可

MIT
