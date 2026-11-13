/**
 * ComfyUI 工作流构建器（纯函数）。
 *
 * 三种通道：
 * - txt2img：EmptySD3LatentImage → KSampler → VAEDecode → SaveImage
 * - classic：参考图编码回 latent，denoise = 重绘强度
 * - edit：TextEncodeQwenImage21 原生多参考图编辑（CFG=1、denoise=1）
 */
import type { Workflow, WorkflowNode } from "../comfy/client.js";

export interface ModelFiles {
  transformer: string;
  textEncoder: string;
  vae: string;
}

export interface BaseParams {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number;
  /** 采样器（euler / res_multistep / …）；编辑通道固定 euler（官方约定） */
  sampler?: string | undefined;
  models: ModelFiles;
}

export type RefMode = "classic" | "edit" | "auto";

/** ref_mode=auto 解析：多图 → edit，单图/无图 → classic。 */
export function resolveRefMode(refCount: number, mode: RefMode): "classic" | "edit" {
  if (mode !== "auto") return mode;
  return refCount > 1 ? "edit" : "classic";
}

function n(class_type: string, inputs: Record<string, unknown>): WorkflowNode {
  return { class_type, inputs };
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** 加载器三件套（节点 1/2/3）+ ModelSamplingAuraFlow（节点 4）。 */
function loaderNodes(models: ModelFiles): Record<string, WorkflowNode> {
  const unet = basename(models.transformer);
  const unetNode = unet.toLowerCase().endsWith(".gguf")
    ? n("UnetLoaderGGUF", { unet_name: unet })
    : n("UNETLoader", { unet_name: unet, weight_dtype: "default" });
  return {
    "1": unetNode,
    "2": n("CLIPLoader", {
      clip_name: basename(models.textEncoder),
      type: "qwen_image",
      device: "default",
    }),
    "3": n("VAELoader", { vae_name: basename(models.vae) }),
    "4": n("ModelSamplingAuraFlow", { model: ["1", 0], shift: 3.1 }),
  };
}

/** 文生图（或无参考图的智能编辑退化为文生图尺寸控制）。 */
export function buildTxt2Img(p: BaseParams): Workflow {
  return {
    ...loaderNodes(p.models),
    "5": n("CLIPTextEncode", { clip: ["2", 0], text: p.prompt }),
    "6": n("CLIPTextEncode", { clip: ["2", 0], text: p.negative }),
    "7": n("EmptySD3LatentImage", {
      width: p.width, height: p.height, batch_size: 1,
    }),
    "9": n("KSampler", {
      model: ["4", 0], positive: ["5", 0], negative: ["6", 0],
      latent_image: ["7", 0], seed: p.seed, steps: p.steps,
      cfg: p.guidance, sampler_name: p.sampler ?? "euler", scheduler: "simple", denoise: 1.0,
    }),
    "10": n("VAEDecode", { samples: ["9", 0], vae: ["3", 0] }),
    "11": n("SaveImage", { images: ["10", 0], filename_prefix: "imagestudio/api" }),
  };
}

/** 传统重绘：refName（已上传的 ComfyUI 文件名）编码回 latent。 */
export function buildClassicRef(
  p: BaseParams,
  refName: string,
  strength: number,
): Workflow {
  const wf = buildTxt2Img(p);
  wf["7"] = n("LoadImage", { image: refName });
  wf["8"] = n("VAEEncode", { pixels: ["7", 0], vae: ["3", 0] });
  wf["9"] = n("KSampler", {
    model: ["4", 0], positive: ["5", 0], negative: ["6", 0],
    latent_image: ["8", 0], seed: p.seed, steps: p.steps,
    cfg: p.guidance, sampler_name: p.sampler ?? "euler", scheduler: "simple",
    denoise: strength,
  });
  return wf;
}

/**
 * 智能编辑：TextEncodeQwenImage21 原生多参考图通道。
 *
 * ⚠️ 关键坑（来自 Python 版排障实录）：Autogrow 输入在 API 格式里必须用
 * 点号键 `images.image_1`、`images.image_2`…；嵌套字典会被静默忽略，
 * 参考图接不上，编辑退化为纯文生图。
 */
export function buildEditRefs(p: BaseParams, refNames: string[]): Workflow {
  const nodes = loaderNodes(p.models);
  // resolution=1024：参考图按总像素预算等比缩放（32 倍数），防手机原图撑爆序列
  const teInputs: Record<string, unknown> = {
    clip: ["2", 0],
    prompt: p.prompt,
    negative_prompt: p.negative,
    vae: ["3", 0],
    resolution: 1024,
  };
  refNames.forEach((name, i) => {
    const id = String(20 + i + 1); // 21, 22, …
    nodes[id] = n("LoadImage", { image: name });
    teInputs[`images.image_${i + 1}`] = [id, 0];
  });
  nodes["12"] = n("TextEncodeQwenImage21", teInputs);
  nodes["9"] = n("KSampler", {
    model: ["4", 0], positive: ["12", 0], negative: ["12", 1],
    latent_image: ["12", 2], seed: p.seed, steps: p.steps,
    cfg: 1.0, // 官方 2.1 路径固定 CFG=1（负面提示词不参与引导）
    sampler_name: "euler", scheduler: "simple", denoise: 1.0,
  });
  nodes["10"] = n("VAEDecode", { samples: ["9", 0], vae: ["3", 0] });
  nodes["11"] = n("SaveImage", { images: ["10", 0], filename_prefix: "imagestudio/api" });
  return nodes;
}

/** 按 resolved 模式选择构建器。 */
export function buildWorkflow(
  p: BaseParams,
  resolved: "classic" | "edit" | "txt2img",
  refNames: string[],
  strength: number,
): Workflow {
  if (resolved === "edit" && refNames.length > 0) return buildEditRefs(p, refNames);
  if (resolved === "classic" && refNames.length > 0) {
    return buildClassicRef(p, refNames[0]!, strength);
  }
  return buildTxt2Img(p);
}

/**
 * 把提示词中的参考图引用归一化为官方 <imageN> 格式。
 * 支持：image_1 / image1 / 第1张图 / 第1张 → <image1>（1 ≤ N ≤ refCount）；
 * 超出 refCount 的引用保持原样。
 */
export function normalizeEditPrompt(prompt: string, refCount: number): string {
  if (!prompt || refCount <= 0) return prompt;
  // 先把已是官方格式的标记替换为占位符，避免被后续模式重复包裹
  const held: string[] = [];
  let out = prompt.replace(/<\s*image[_\s]?\d+\s*>/gi, (m) => {
    held.push(m.replace(/[\s_]/g, "").toLowerCase());
    return `\x00${held.length - 1}\x00`;
  });
  const patterns: RegExp[] = [
    /\bimage[_\s]?(\d+)\b/gi,
    /第\s*(\d+)\s*张/g,
  ];
  for (const pat of patterns) {
    out = out.replace(pat, (m, d: string) => {
      const num = parseInt(d, 10);
      return num >= 1 && num <= refCount ? `<image${num}>` : m;
    });
  }
  return out.replace(/\x00(\d+)\x00/g, (_m, i: string) => held[Number(i)]!);
}
