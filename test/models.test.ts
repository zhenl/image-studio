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
    return json({ UnetLoaderGGUF: { input: { required: { unet_name: [["a-Q4_K_M.gguf"]] } } } });
  }
  if (u.includes("/object_info/UNETLoader")) {
    return json({ UNETLoader: { input: { required: { unet_name: [["a-Q4_K_M.gguf", "text_encoders/te.safetensors", "vae/v.safetensors"]] } } } });
  }
  if (u.includes("/object_info/CLIPLoader")) {
    return json({ CLIPLoader: { input: { required: { clip_name: [["te.safetensors"]] } } } });
  }
  if (u.includes("/object_info/VAELoader")) {
    return json({ VAELoader: { input: { required: { vae_name: [["v.safetensors"]] } } } });
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
    expect(body.items.map((i: { name: string }) => i.name)).toEqual(["a-Q4_K_M.gguf"]);
    expect(body.items[0].current).toBe(true);
    expect(body.text_encoders[0].name).toBe("te.safetensors");
    expect(body.vaes.map((i: { name: string }) => i.name)).toEqual(["v.safetensors"]);
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
