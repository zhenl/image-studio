import { describe, it, expect } from "vitest";
import {
  buildTxt2Img, buildClassicRef, buildEditRefs, buildWorkflow,
  normalizeEditPrompt, resolveRefMode,
  type BaseParams,
} from "../src/workflow/builder.js";

const p: BaseParams = {
  prompt: "a cat", negative: "blurry", width: 768, height: 768,
  steps: 8, guidance: 4.0, seed: 42,
  models: {
    transformer: "qwen-image-2.1-UC-Q4_K_M.gguf",
    textEncoder: "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
    vae: "vae/qwen_image_2.1_vae_bf16.safetensors",
  },
};

describe("resolveRefMode", () => {
  it("auto：0/1 张 → classic，多张 → edit", () => {
    expect(resolveRefMode(0, "auto")).toBe("classic");
    expect(resolveRefMode(1, "auto")).toBe("classic");
    expect(resolveRefMode(2, "auto")).toBe("edit");
  });
  it("显式指定优先于 auto 规则", () => {
    expect(resolveRefMode(1, "edit")).toBe("edit");
    expect(resolveRefMode(5, "classic")).toBe("classic");
  });
});

describe("buildTxt2Img", () => {
  const wf = buildTxt2Img(p);

  it("加载器三件套按文件名引用（带子目录前缀取 basename）", () => {
    expect(wf["1"]).toEqual({
      class_type: "UnetLoaderGGUF",
      inputs: { unet_name: "qwen-image-2.1-UC-Q4_K_M.gguf" },
    });
    expect(wf["2"]!.inputs.clip_name).toBe("qwen3vl_8b_int8_convrot.safetensors");
    expect(wf["2"]!.inputs.type).toBe("qwen_image");
    expect(wf["3"]!.inputs.vae_name).toBe("qwen_image_2.1_vae_bf16.safetensors");
  });

  it("采样器可选：默认 euler，可指定 res_multistep", () => {
    const ks1 = buildTxt2Img(p)["9"]!.inputs as Record<string, unknown>;
    expect(ks1.sampler_name).toBe("euler");
    const wf2 = buildTxt2Img({ ...p, sampler: "res_multistep" });
    const ks2 = wf2["9"]!.inputs as Record<string, unknown>;
    expect(ks2.sampler_name).toBe("res_multistep");
    // 传统重绘同样生效
    const wf3 = buildClassicRef({ ...p, sampler: "res_multistep" }, "r.png", 0.6);
    expect((wf3["9"]!.inputs as Record<string, unknown>).sampler_name).toBe("res_multistep");
  });

  it("safetensors 扩散模型走官方 UNETLoader", () => {
    const wf2 = buildTxt2Img({
      ...p, models: { ...p.models, transformer: "model.safetensors" },
    });
    expect(wf2["1"]!.class_type).toBe("UNETLoader");
    expect(wf2["1"]!.inputs.weight_dtype).toBe("default");
  });

  it("KSampler 接线与参数", () => {
    const ks = wf["9"]!.inputs as Record<string, unknown>;
    expect(ks.latent_image).toEqual(["7", 0]);
    expect(ks.seed).toBe(42);
    expect(ks.cfg).toBe(4.0);
    expect(ks.denoise).toBe(1.0);
  });

  it("正负面提示词各接一个 CLIPTextEncode", () => {
    expect(wf["5"]!.inputs.text).toBe("a cat");
    expect(wf["6"]!.inputs.text).toBe("blurry");
  });
});

describe("buildClassicRef", () => {
  it("参考图编码回 latent，denoise=重绘强度", () => {
    const wf = buildClassicRef(p, "ref.png", 0.6);
    expect(wf["7"]).toEqual({ class_type: "LoadImage", inputs: { image: "ref.png" } });
    expect(wf["8"]!.class_type).toBe("VAEEncode");
    const ks = wf["9"]!.inputs as Record<string, unknown>;
    expect(ks.latent_image).toEqual(["8", 0]);
    expect(ks.denoise).toBe(0.6);
  });
});

describe("buildEditRefs", () => {
  it("多参考图用点号键 images.image_N 接入 TextEncodeQwenImage21", () => {
    const wf = buildEditRefs(p, ["a.png", "b.png", "c.png"]);
    const te = wf["12"]!.inputs as Record<string, unknown>;
    expect(te["images.image_1"]).toEqual(["21", 0]);
    expect(te["images.image_2"]).toEqual(["22", 0]);
    expect(te["images.image_3"]).toEqual(["23", 0]);
    expect(wf["21"]).toEqual({ class_type: "LoadImage", inputs: { image: "a.png" } });
    expect(wf["23"]!.inputs.image).toBe("c.png");
    expect(te.resolution).toBe(1024);
  });

  it("编辑通道官方约定：CFG=1、denoise=1、三件套输出直连", () => {
    const wf = buildEditRefs(p, ["a.png"]);
    const ks = wf["9"]!.inputs as Record<string, unknown>;
    expect(ks.cfg).toBe(1.0);
    expect(ks.denoise).toBe(1.0);
    expect(ks.positive).toEqual(["12", 0]);
    expect(ks.negative).toEqual(["12", 1]);
    expect(ks.latent_image).toEqual(["12", 2]);
  });

  it("9 张参考图全部接线（节点 id 不冲突）", () => {
    const names = Array.from({ length: 9 }, (_, i) => `r${i + 1}.png`);
    const wf = buildEditRefs(p, names);
    const te = wf["12"]!.inputs as Record<string, unknown>;
    expect(te["images.image_9"]).toEqual(["29", 0]);
    for (let i = 1; i <= 9; i++) expect(wf[String(20 + i)]).toBeDefined();
  });
});

describe("buildWorkflow 路由", () => {
  it("edit 模式走编辑通道", () => {
    const wf = buildWorkflow(p, "edit", ["a.png", "b.png"], 0.6);
    expect(wf["12"]!.class_type).toBe("TextEncodeQwenImage21");
  });
  it("classic 模式只用第 1 张", () => {
    const wf = buildWorkflow(p, "classic", ["a.png", "b.png"], 0.5);
    expect(wf["12"]).toBeUndefined();
    expect(wf["8"]!.class_type).toBe("VAEEncode");
  });
  it("无参考图退化为文生图", () => {
    const wf = buildWorkflow(p, "edit", [], 0.6);
    expect(wf["7"]!.class_type).toBe("EmptySD3LatentImage");
  });
});

describe("normalizeEditPrompt", () => {
  it("各种写法归一化为 <imageN>", () => {
    expect(normalizeEditPrompt("把 image_2 的人物放进 image_1", 3))
      .toBe("把 <image2> 的人物放进 <image1>");
    expect(normalizeEditPrompt("use image3 here", 3)).toBe("use <image3> here");
    expect(normalizeEditPrompt("把第2张图的帽子给第1张图", 3))
      .toBe("把<image2>图的帽子给<image1>图");
  });

  it("已是官方格式的保持不变（不重复包裹）", () => {
    expect(normalizeEditPrompt("<image1> with <image2>", 2))
      .toBe("<image1> with <image2>");
  });

  it("超出参考图数量的引用保持原样", () => {
    expect(normalizeEditPrompt("image_5 too far", 3)).toBe("image_5 too far");
  });

  it("空提示词 / 无参考图原样返回", () => {
    expect(normalizeEditPrompt("", 3)).toBe("");
    expect(normalizeEditPrompt("image_1", 0)).toBe("image_1");
  });
});
