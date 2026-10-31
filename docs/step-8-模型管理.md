# Step 8 · 模型管理、状态徽章与项目收尾

对应分支 `step-8-model-mgmt`。补齐最后两块面向"共享 ComfyUI 部署"
的功能（移植自 qwenimage-studio 的改造实践），并完成项目收尾。

## 完成内容

| 功能 | 实现 |
|:---|:---|
| `GET /api/v1/models/list` | 查询 ComfyUI `/object_info`（UnetLoaderGGUF/UNETLoader/CLIPLoader/VAELoader 并集）——共享模式下唯一权威的模型列表；剔除 UNETLoader 混入的 text_encoders/vae 子目录条目 |
| `POST /api/v1/models/select` | 三类模型选择；逐项在 ComfyUI 可见列表中校验（防拼错文件名静默失败）；运行时即时生效 + 持久化 .env |
| 前端「模型管理」弹窗 | 三组下拉 + 应用按钮；ComfyUI 不可达时明确提示 |
| 状态徽章 | `ping /system_stats` 真实可达性（非引擎内部标志） |
| README | 项目说明、架构图、8 步分支索引、与 Python 版对照表 |

## 关键技术

### 为什么列表必须来自 ComfyUI 而不是本地扫描

共享部署下模型由 ComfyUI 通过 `extra_model_paths.yaml` 管理，
本地目录扫描可能与 ComfyUI 实际可见的文件不一致（路径映射、缓存、
权限）。`/object_info` 返回的加载器可选值列表就是"ComfyUI 眼中的
世界"——qwenimage-studio 改造时确立的原则，这里直接继承。

两个实现细节：

1. **类别过滤**：官方 `UNETLoader` 会把模型目录下所有权重都列出来
   （包括 text_encoders/、vae/ 子目录），需按路径首段剔除
2. **当前项兜底**：当前选中的文件若不在列表中（如 ComfyUI 刚换过
   目录），仍展示出来并标注 current，避免界面"不知道现在用的是什么"

### 选择的持久化与即时生效

运行时改 `cfg.TRANSFORMER_FILE` 即时生效（工作流按文件名引用，
ComfyUI 自动加载新权重）+ 写回 .env 重启保留。持久化目标
`envFileAbs` 做成配置项——测试指向临时文件，避免单测污染项目 .env
（这是"可注入配置"原则的又一次兑现）。

### 共享模式不做 unload

模型的加载/卸载完全交给 ComfyUI（工作流引用新文件即触发加载，
权重缓存由 ComfyUI 管理）。应用端不再有"加载/卸载模型"按钮——
对应 qwenimage-studio 界面精简的结论。

## 最终验证（真实环境联调）

对真实 comfy-service（ComfyUI @ 8188，RTX 5090）：

- `GET /api/v1/status` → `loaded: true`，GPU 名称与显存正确
- `GET /api/v1/models/list` → `source: "comfy"`，三类模型与
  `extra_model_paths.yaml` 映射一致
- `POST /api/v1/generate` → 真实出图落盘，图库可见
- 前端 http://127.0.0.1:8030 完整走通文生图 / 图生图 / 队列 / 图库

## 项目收尾状态

- **112 个单元测试全部通过**；覆盖率 lines 97.1% / branches 85.8%
  / functions 98.8%（阈值 90/85/90 建在 vitest 配置里，不达标即失败）
- `tsc --noEmit` 零错误（strict + noUncheckedIndexedAccess +
  exactOptionalPropertyTypes 三项严格开关全开）
- 8 个 step 分支 + master 成品；每步一篇 `docs/step-N-*.md`
