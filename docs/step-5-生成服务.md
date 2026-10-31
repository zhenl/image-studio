# Step 5 · 生成服务：编排、参考图预处理与耗时自校准

对应分支 `step-5-generation`。本步骤把前三步的零件（客户端、工作流、
队列/存储）装配成完整的出图编排，并移植 Python 版的两大实践：
参考图预处理与耗时自校准。

## 完成内容

| 模块 | 职责 |
|:---|:---|
| `src/services/generation.ts` | `GenerationService.runJob`：解析参数 → 预处理并上传参考图 → 构建工作流 → 提交 → 监听进度 → 取图 → 落盘 → 入库 → 发布事件 |
| `src/services/refs.ts` | `fitReference`（长边 1536 / 32 倍数）、`resizeToCanvas`（第 1 张对齐输出画布） |
| `src/services/calibration.ts` | 耗时自校准：images 表中位数拟合 `k·步数·MP`，30s 缓存，无样本回退 RTX 2060 参考值 |

## 关键技术

### 引擎以最小接口注入

`EngineLike` 只声明服务真正用到的 5 个方法（upload/submit/listen/
history/view）。生产传 `ComfyClient`（结构满足即可，无需显式
implements——TS 鸭子类型的正确用法），测试传记录调用序列的假实现。
假引擎让"提交→监听→取图"的**调用顺序**都成为断言对象。

### sharp 替代 Pillow

参考图预处理规则与 Python 版一致：

- 第 1 张（画布）：`resizeToCanvas` 到输出尺寸——latent 尺寸由它决定
- 其余参考图：`fitReference` 长边压到 1536、对齐 32 倍数——
  12MP 手机原图会撑爆视觉序列与 VAE latent，且超出模型 2K 训练
  范围会明显劣化提示词遵循度

sharp 底层是 libvips，比 Pillow 快且内存占用低；测试里直接生成
真实 PNG 走完整处理管线，断言输出尺寸与 32 对齐。

### 种子语义

- `-1` 随机：`crypto.randomInt(0, 2^31)`
- 固定种子 + 批量：`seed + index`——同任务多张图可复现且互不相同

### 取消检查点

`shouldCancel(jobId)` 回调注入（生产接调度器）。检查点在**每张图
开始前**——单张推理中途不中断（共享 ComfyUI 下无法安全打断），
但批量任务能在张与张之间停下，标记 canceled 并发布 done 事件。

### 耗时自校准（移植 Python 版）

`Calibrator.estimate(w, h, steps, batch)`：

```
seconds = k · steps · MP · batch + overhead
```

- `k` 取最近 30 条 images 记录 `elapsed/(steps·MP)` 的**中位数**
  （抗离群点：偶发的冷启动/后台抢占不会拉偏估计）
- 30s TTL 缓存：估算面板输入抖动时不反复扫表
- 无样本回退 `k=260`（RTX 2060 参考值）并标注 `calibrated: false`，
  前端据此提示"未校准"——与 qwenimage-studio 的行为一致
  （实测校准后误差 ~10%）

## 测试

- 92 用例全过，覆盖率 99.86%（branches 90.33%）
- 生成服务 8 场景：全流程事件序列、批量种子递增、双图 edit 通道
  （提示词归一化断言）、单图 classic、推理失败、空输出、张间取消
- 校准器 5 场景：回退/校准/缓存 TTL/无效样本过滤/批量线性
- 参考图 4 场景：尺寸收敛与 32 对齐（真实 sharp 管线）
