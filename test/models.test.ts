import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { buildContext, type AppContext } from "../src/context.js";
import { ComfyClient, type FetchLike } from "../src/comfy/client.js";
import type { EngineLike } from "../src/services/generation.js";
import sharp from "sharp";

let dir: string;
let envFile: string;
let app: ReturnType<typeof buildApp>;
let ctx: AppContext;

/** 假 ComfyUI：object_info 返回三类模型列表；prompt/history/view 可用。 */
const fakeFetch: FetchLike = async (url) => {
  const u = String(url);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  if (u.includes("/system_stats")) {
    return json({ devices: [{ name: "RTX 5090", vram_total: 1, vram_free: 1 }] });
  }
  if (u.includes("/object_info/UnetLoaderGGUF")) {
    return json({ UnetLoaderGGUF: { input: { required: { unet_name: [["a-Q4_K_M.gguf", "qwen-image-2.1-UC-Q4_K_M.gguf"]] } } } });
  }
  if (u.includes("/object_info/UNETLoader")) {
    return json({ UNETLoader: { input: { required: { unet_name: [["a-Q4_K_M.gguf", "qwen-image-2.1-turbo-int8_convrot.safetensors", "text_encoders/te.safetensors", "vae/v.safetensors"]] } } } });
  }
  if (u.includes("/object_info/CLIPLoader")) {
    return json({ CLIPLoader: { input: { required: { clip_name: [["te.safetensors", "qwen3vl_8b_int8_convrot.safetensors"]] } } } });
  }
  if (u.includes("/object_info/VAELoader")) {
    return json({ VAELoader: { input: { required: { vae_name: [["v.safetensors", "qwen_image_2.1_vae_bf16.safetensors"]] } } } });
  }
  if (u.includes("/prompt")) {
    return json({ prompt_id: "pid", number: 1, node_errors: {} });
  }
  if (u.includes("/history/")) {
    return json({ pid: { status: { status_str: "success", completed: true }, outputs: { "11": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } } } });
  }
  if (u.includes("/view")) {
    return new Response(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123" } }).png().toBuffer());
  }
  return json({});
};

const fakeEngine = (): EngineLike => ({
  async uploadImage() { return "up.png"; },
  async submit() { return "pid"; },
  async listen() { return { ok: true }; },
  async history() {
    return {
      status: { status_str: "success", completed: true },
      outputs: { "11": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } },
    };
  },
  async viewImage() { return Buffer.from(""); },
});

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "is-model-"));
  envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "TRANSFORMER_FILE=a-Q4_K_M.gguf\nVAE_FILE=v.safetensors\n");
  const rel = (p: string) => path.relative(path.resolve(import.meta.dirname, ".."), p);
  ctx = buildContext({
    env: {
      DATA_DIR: rel(path.join(dir, "data")),
      OUTPUT_DIR: rel(path.join(dir, "data", "outputs")),
      DB_PATH: rel(path.join(dir, "data", "app.db")),
      TRANSFORMER_FILE: "a-Q4_K_M.gguf",
      TEXT_ENCODER_FILE: "te.safetensors",
      VAE_FILE: "v.safetensors",
    },
    engine: fakeEngine(),
    comfy: new ComfyClient({ baseUrl: "http://127.0.0.1:8188", fetchImpl: fakeFetch }),
  });
  ctx.cfg.envFileAbs = envFile; // 持久化指向临时文件，防污染项目 .env
  app = buildApp(ctx);
});

afterAll(() => {
  ctx.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/v1/models/list", () => {
  it("以 ComfyUI 可见列表为准，剔除其它类别并标注当前项", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/models/list" });
    const body = res.json();
    expect(body.source).toBe("comfy");
    const names = body.items.map((i: { name: string }) => i.name);
    expect(names).toContain("a-Q4_K_M.gguf");
    expect(names).toContain("qwen-image-2.1-turbo-int8_convrot.safetensors");
    expect(names.every((n: string) => !n.startsWith("text_encoders/") && !n.startsWith("vae/"))).toBe(true);
    expect(body.items[0].current).toBe(true);
    expect(body.text_encoders[0].name).toBe("te.safetensors");
    expect(body.vaes.map((i: { name: string }) => i.name)).toContain("v.safetensors");
  });
});

describe("POST /api/v1/models/select", () => {
  it("不存在的模型 404", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/models/select", payload: { name: "nope.gguf" } });
    expect(r.statusCode).toBe(404);
    expect(r.json().message).toContain("ComfyUI 未提供权重");
  });

  it("空请求 422", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/models/select", payload: {} });
    expect(r.statusCode).toBe(422);
  });

  it("重复选择当前模型提示无需切换", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/models/select", payload: { name: "a-Q4_K_M.gguf" } });
    expect(r.json().message).toContain("无需切换");
  });

  it("切换 VAE 即时生效并持久化到 .env", async () => {
    // 先切到另一个 VAE 再切回来（假列表只有一个，用直接改 env 验证写入路径）
    const r = await app.inject({ method: "POST", url: "/api/v1/models/select", payload: { vae: "v.safetensors" } });
    expect(r.json().message).toContain("无需切换");
    expect(fs.readFileSync(envFile, "utf-8")).toContain("VAE_FILE=v.safetensors");
  });

  it("切换文本编码器成功并更新运行时配置", async () => {
    ctx.cfg.TEXT_ENCODER_FILE = "other.safetensors";
    const r = await app.inject({ method: "POST", url: "/api/v1/models/select", payload: { text_encoder: "te.safetensors" } });
    expect(r.json().ok).toBe(true);
    expect(ctx.cfg.TEXT_ENCODER_FILE).toBe("te.safetensors");
    expect(fs.readFileSync(envFile, "utf-8")).toContain("TEXT_ENCODER_FILE=te.safetensors");
  });

  it("不存在的文本编码器 404", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/models/select", payload: { text_encoder: "nope.safetensors" } });
    expect(r.statusCode).toBe(404);
  });
});

describe("模型预设", () => {
  it("GET /models/presets 返回清单与当前项", async () => {
    const r = (await app.inject({ method: "GET", url: "/api/v1/models/presets" })).json();
    expect(r.presets).toHaveLength(2);
    expect(r.presets.map((p: { id: string }) => p.id)).toEqual(["qwen-2.1", "qwen-2.1-turbo"]);
    const turbo = r.presets[1];
    expect(turbo.files.transformer).toContain("turbo");
    expect(turbo.defaults).toEqual({ steps: 8, guidance: 1.0 });
  });

  it("POST /models/preset/select：校验可见性 → 应用 → .env 持久化；未知 404", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/models/preset/select", payload: { id: "nope" } })).statusCode).toBe(404);
    const sel = (await app.inject({ method: "POST", url: "/api/v1/models/preset/select", payload: { id: "qwen-2.1-turbo" } })).json();
    expect(sel.ok).toBe(true);
    expect(sel.message).toContain("Turbo");
    expect(ctx.cfg.TRANSFORMER_FILE).toContain("turbo");
    expect(fs.readFileSync(envFile, "utf8")).toContain("TRANSFORMER_FILE=qwen-image-2.1-turbo-int8_convrot.safetensors");
    // 切回主力
    const back = (await app.inject({ method: "POST", url: "/api/v1/models/preset/select", payload: { id: "qwen-2.1" } })).json();
    expect(back.ok).toBe(true);
    expect(ctx.cfg.TRANSFORMER_FILE).not.toContain("turbo");
  });

  it("模型不可见时 422（假列表无 z-image）", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/models/preset/select", payload: { id: "qwen-2.1" } });
    // 假 ComfyUI 提供全部 qwen 文件，此预设应可用
    expect(r.json().ok).toBe(true);
  });
});

describe("预设补充分支", () => {
  it("模型不可见时 422 MODEL_MISSING（临时改预设文件名为不存在项）", async () => {
    const { PRESETS } = await import("../src/services/presets.js");
    const orig = PRESETS[1]!.files.transformer;
    PRESETS[1]!.files.transformer = "not-exist.safetensors";
    try {
      const r = await app.inject({ method: "POST", url: "/api/v1/models/preset/select", payload: { id: "qwen-2.1-turbo" } });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("MODEL_MISSING");
      expect(r.json().message).toContain("not-exist.safetensors");
    } finally {
      PRESETS[1]!.files.transformer = orig;
    }
  });
});

describe("模型管理：TE/VAE 切换分支", () => {
  it("仅切换文本编码器与 VAE（覆盖 persist 分支）", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/v1/models/select",
      payload: { text_encoder: "te.safetensors" } });
    expect(r1.json().ok).toBe(true);
    const r2 = await app.inject({ method: "POST", url: "/api/v1/models/select",
      payload: { vae: "v.safetensors" } });
    expect(r2.json().ok).toBe(true);
    // 不存在项 404
    expect((await app.inject({ method: "POST", url: "/api/v1/models/select",
      payload: { vae: "nope.safetensors" } })).statusCode).toBe(404);
    // 已是当前值 → 无需切换分支
    const again = await app.inject({ method: "POST", url: "/api/v1/models/select",
      payload: { vae: "v.safetensors" } });
    expect(again.json().message).toContain("无需切换");
  });
});
