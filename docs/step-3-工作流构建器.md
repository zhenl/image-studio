# Step 3 · 工作流构建器：三种通道的纯函数拼装

对应分支 `step-3-workflow`。应用端的"业务逻辑核心"就是按参数拼出
ComfyUI API 格式的工作流 JSON——本步骤把它做成**纯函数**，
没有 I/O、没有状态，是全项目测试最容易写满的模块。

## 完成内容（src/workflow/builder.ts）

| 函数 | 通道 | 关键节点链 |
|:---|:---|:---|
| `buildTxt2Img` | 文生图 | `EmptySD3LatentImage → KSampler → VAEDecode → SaveImage` |
| `buildClassicRef` | 传统重绘 | `LoadImage → VAEEncode → KSampler(denoise=强度)` |
| `buildEditRefs` | 智能编辑 | `TextEncodeQwenImage21`（N 张参考图）→ `KSampler(CFG=1, denoise=1)` |
| `buildWorkflow` | 路由 | 按 resolved 模式选择上述构建器 |
| `resolveRefMode` | auto 解析 | 多图 → edit，单图/无图 → classic |
| `normalizeEditPrompt` | 提示词归一化 | `image_1` / `image1` / `第1张` → `<image1>` |

## 关键技术

### 模型按文件名引用 + basename 容错

工作流只写文件名（`unet_name` / `clip_name` / `vae_name`），
ComfyUI 按 `extra_model_paths.yaml` 解析磁盘位置。配置里带
`text_encoders/` 子目录前缀时统一取 basename，与 Python 版一致。

`.gguf` 走 `UnetLoaderGGUF`，`.safetensors` 走官方 `UNETLoader`——
按扩展名自动切换，为将来对比验证两种格式留口。

### 智能编辑通道的两个官方约定（+ 一个坑）

1. `CFG=1`、`denoise=1`：Qwen-Image 2.1 编辑路径的官方采样约定，
   负面提示词不参与引导；latent 用 `TextEncodeQwenImage21` 的第三输出
   （尺寸跟随 image_1）
2. `resolution=1024`：参考图按总像素预算等比缩放，防手机原图
   （3000×4000+，12MP）撑爆视觉序列与 VAE latent——超出模型 2K
   训练范围会明显劣化提示词遵循度
3. **点号键坑**（Python 版排障实录）：Autogrow 输入在 API 格式里必须写
   `images.image_1`、`images.image_2`…；写成嵌套字典
   `{"images": {...}}` 会被 ComfyUI **静默忽略**——参考图完全接不上，
   编辑退化为无参考的纯文生图。构建器为此把接线写成显式循环：
   ```typescript
   refNames.forEach((name, i) => {
     nodes[String(21 + i)] = n("LoadImage", { image: name });
     teInputs[`images.image_${i + 1}`] = [String(21 + i), 0];
   });
   ```

### normalizeEditPrompt 的防重复包裹

`<image1>` 会被 `image1` 的模式二次命中变成 `<<image1>>`。
解法：先把已是官方格式的标记替换为占位符（`\x00N\x00`），
跑完所有归一化模式后再还原——对应 Python 版注释里
"先拆掉已有的合法标记，最后再还原"的思路。

### 为什么纯函数值得

工作流是"字段拼错就静默失败"的 JSON。纯函数 + 快照式断言
（`expect(wf["12"].inputs["images.image_3"]).toEqual(["23", 0])`）
让每种接线索引都有编译期类型与运行时双保险——这是 TS 相对 Python
dict 字面量的核心增益。

## 测试

- 17 个用例：三通道全节点断言、9 张参考图接线、
  归一化的中文/英文/越界/幂等场景
- 全项目 60 用例，覆盖率 99.73%（branches 90.17%），typecheck 通过
