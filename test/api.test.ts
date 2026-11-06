import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildApp } from "../src/app.js";
import { buildContext, type AppContext } from "../src/context.js";
import type { EngineLike } from "../src/services/generation.js";
import { ComfyClient } from "../src/comfy/client.js";

let dir: string;
let app: ReturnType<typeof buildApp>;
let ctx: AppContext;
let uploaded = 0;

const fakeEngine = (): EngineLike => ({
  async uploadImage() { uploaded++; return `up${uploaded}.png`; },
  async submit() { return "pid-1"; },
  async listen(_c, _p, onEvent) {
    onEvent({ type: "progress", data: { value: 4, max: 8 } });
    return { ok: true };
  },
  async history() {
    return {
      status: { status_str: "success", completed: true },
      outputs: { "11": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
    };
  },
  async viewImage() {
    return sharp({ create: { width: 64, height: 64, channels: 3, background: "#f80" } }).png().toBuffer();
  },
});

/** 假 ComfyClient：ping 成功、给出设备信息。 */
const fakeComfy = () => new ComfyClient({
  baseUrl: "http://127.0.0.1:8188",
  fetchImpl: async (url) => {
    if (String(url).includes("/system_stats")) {
      return new Response(JSON.stringify({
        devices: [{ name: "RTX 5090", vram_total: 24 * 1024 ** 3, vram_free: 20 * 1024 ** 3 }],
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  },
});

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "is-api-"));
  ctx = buildContext({
    env: {
      DATA_DIR: path.relative(path.resolve(import.meta.dirname, ".."), path.join(dir, "data")),
      OUTPUT_DIR: path.relative(path.resolve(import.meta.dirname, ".."), path.join(dir, "data", "outputs")),
      DB_PATH: path.relative(path.resolve(import.meta.dirname, ".."), path.join(dir, "data", "app.db")),
    },
    engine: fakeEngine(),
    comfy: fakeComfy(),
  });
  app = buildApp(ctx);
});

afterAll(() => {
  ctx.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const validBody = { prompt: "a cat", width: 512, height: 512, steps: 4 };

describe("POST /api/v1/preview（估算）", () => {
  it("未校准时返回回退值与提示", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/preview",
      payload: { width: 1024, height: 1024, steps: 20, batch_size: 1 },
    });
    const body = res.json();
    expect(body.calibrated).toBe(false);
    expect(body.warnings.join()).toContain("尚无出图记录");
    expect(body.estimated_seconds).toBeGreaterThan(1000);
  });

  it("出图后校准为准确值", async () => {
    await app.inject({ method: "POST", url: "/api/v1/generate", payload: validBody });
    ctx.calibrator.invalidate(); // 绕过 30s 缓存（生产由 TTL 自动刷新）
    const res = await app.inject({
      method: "POST", url: "/api/v1/preview",
      payload: { width: 512, height: 512, steps: 4, batch_size: 1 },
    });
    const body = res.json();
    expect(body.calibrated).toBe(true);
    expect(body.samples).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/generate（同步）", () => {
  it("成功出图并返回任务与图片", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/generate", payload: validBody });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("succeeded");
    expect(body.images).toHaveLength(1);
    expect(body.images[0].url).toMatch(/^\/.*\.png$/);
  });

  it("batch_size=2 出两张图", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/generate",
      payload: { ...validBody, batch_size: 2, seed: 42 },
    });
    const body = res.json();
    expect(body.images).toHaveLength(2);
    expect(body.images.map((i: { seed: number }) => i.seed)).toEqual([42, 43]);
  });

  it("非法参数 422（宽非 64 倍数 / 空提示词 / 超过 9 张参考图）", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/v1/generate", payload: { ...validBody, width: 100 } });
    expect(r1.statusCode).toBe(422);
    const r2 = await app.inject({ method: "POST", url: "/api/v1/generate", payload: { ...validBody, prompt: "  " } });
    expect(r2.statusCode).toBe(422);
    const r3 = await app.inject({
      method: "POST", url: "/api/v1/generate",
      payload: { ...validBody, mode: "img2img", ref_images: Array.from({ length: 10 }, () => "data:image/png;base64,xxxx") },
    });
    expect(r3.statusCode).toBe(422);
  });
});

describe("POST /api/v1/jobs（异步）", () => {
  it("入队返回 202 与位置，任务最终成功", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/jobs", payload: validBody });
    expect(res.statusCode).toBe(202);
    const { job_id, status } = res.json();
    expect(status).toBe("queued");
    await viWaitFor(async () => {
      const r = await app.inject({ method: "GET", url: `/api/v1/jobs/${job_id}` });
      expect(r.json().status).toBe("succeeded");
    });
  });

  it("任务列表与详情", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/jobs?limit=5" });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThan(0);
  });

  it("详情不存在返回 404", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/jobs/nope" });
    expect(r.statusCode).toBe(404);
  });
});

async function viWaitFor(fn: () => Promise<void>, timeout = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try { await fn(); return; }
    catch { if (Date.now() - start > timeout) throw new Error("waitFor 超时"); }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("图库与收藏", () => {
  it("列表 / 收藏切换 / 不存在 404", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/v1/gallery" })).json();
    const id = list.items[0].id;
    const fav = await app.inject({ method: "POST", url: `/api/v1/gallery/${id}/favorite`, payload: { favorite: true } });
    expect(fav.json().ok).toBe(true);
    const favList = (await app.inject({ method: "GET", url: "/api/v1/gallery?favorite=1" })).json();
    expect(favList.items.some((i: { id: string }) => i.id === id)).toBe(true);
    const r404 = await app.inject({ method: "POST", url: "/api/v1/gallery/nope/favorite", payload: {} });
    expect(r404.statusCode).toBe(404);
  });
});

describe("GET /api/v1/status", () => {
  it("ping ComfyUI 成功：loaded=true 带 GPU 信息", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/status" });
    const body = res.json();
    expect(body.loaded).toBe(true);
    expect(body.gpu_name).toBe("RTX 5090");
    expect(body.comfyui_url).toContain("8188");
  });
});

describe("DELETE /api/v1/jobs/:id", () => {
  it("删除任务（含取消）与不存在 404", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/jobs", payload: validBody });
    const id = created.json().job_id;
    const del = await app.inject({ method: "DELETE", url: `/api/v1/jobs/${id}` });
    expect(del.json().ok).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/v1/jobs/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/jobs/nope" })).statusCode).toBe(404);
  });
});

describe("SSE /api/v1/jobs/:id/events", () => {
  it("已完成任务立即收到 done 事件", async () => {
    const gen = await app.inject({ method: "POST", url: "/api/v1/generate", payload: validBody });
    const id = gen.json().id;
    const res = await app.inject({ method: "GET", url: `/api/v1/jobs/${id}/events` });
    expect(res.body).toContain("event: done");
    expect(res.body).toContain("succeeded");
  });
});

describe("静态产物 /data/*", () => {
  it("可通过 url 取回图片；越权路径 403；不存在 404", async () => {
    const gen = await app.inject({ method: "POST", url: "/api/v1/generate", payload: validBody });
    const url = gen.json().images[0].url;
    const img = await app.inject({ method: "GET", url });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    const evil = await app.inject({ method: "GET", url: "/data/../../etc/passwd" });
    expect([403, 404]).toContain(evil.statusCode);
    const none = await app.inject({ method: "GET", url: "/data/nope/none.png" });
    expect(none.statusCode).toBe(404);
  });
});

describe("图库删除与批量操作", () => {
  async function genOne(): Promise<{ id: string; url: string }> {
    const r = await app.inject({ method: "POST", url: "/api/v1/generate", payload: validBody });
    return r.json().images[0];
  }

  it("DELETE /gallery/:id 删除记录与文件；重复删除 404", async () => {
    const img = await genOne();
    expect((await app.inject({ method: "GET", url: img.url })).statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/gallery/${img.id}` });
    expect(del.json().ok).toBe(true);
    expect((await app.inject({ method: "GET", url: img.url })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/gallery/${img.id}` })).statusCode).toBe(404);
  });

  it("POST /gallery/batch-delete 混合存在/不存在的 id", async () => {
    const a = await genOne();
    const b = await genOne();
    const res = await app.inject({
      method: "POST", url: "/api/v1/gallery/batch-delete",
      payload: { ids: [a.id, b.id, "img_nothere"] },
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain("已删除 2 张");
    expect(body.message).toContain("1 张不存在");
  });

  it("空 ids 422", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/gallery/batch-delete", payload: { ids: [] } });
    expect(r.statusCode).toBe(422);
  });

  it("GET /gallery/batch-download 返回 zip（EOCD 签名）", async () => {
    const a = await genOne();
    const b = await genOne();
    const res = await app.inject({
      method: "GET", url: `/api/v1/gallery/batch-download?ids=${encodeURIComponent([a.id, b.id].join(","))}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    const buf = Buffer.from(res.rawPayload);
    expect(buf.subarray(buf.length - 22).readUInt32LE(0)).toBe(0x06054b50);
    expect(buf.subarray(buf.length - 22).readUInt16LE(8)).toBe(2);
    await app.inject({ method: "POST", url: "/api/v1/gallery/batch-delete", payload: { ids: [a.id, b.id] } });
  });

  it("batch-download 空/全不存在 422/404", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/gallery/batch-download?ids=" })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/v1/gallery/batch-download?ids=img_nothere" })).statusCode).toBe(404);
  });
});

describe("任务详情与批量删除", () => {
  it("GET /jobs/:id 返回含参数快照", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/generate", payload: validBody });
    const id = r.json().id;
    const detail = (await app.inject({ method: "GET", url: `/api/v1/jobs/${id}` })).json();
    expect(detail.params).toMatchObject({ prompt: "a cat", width: 512 });
    expect(detail.images).toHaveLength(1);
  });

  it("POST /jobs/batch-delete 删除多个；空 ids 422", async () => {
    const a = (await app.inject({ method: "POST", url: "/api/v1/jobs", payload: validBody })).json();
    const b = (await app.inject({ method: "POST", url: "/api/v1/jobs", payload: validBody })).json();
    const res = await app.inject({
      method: "POST", url: "/api/v1/jobs/batch-delete",
      payload: { ids: [a.job_id, b.job_id, "job_nothere"] },
    });
    expect(res.json().message).toContain("已删除 2 个");
    expect((await app.inject({ method: "GET", url: `/api/v1/jobs/${a.job_id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/jobs/batch-delete", payload: { ids: [] } })).statusCode).toBe(422);
  });
});

describe("提示词库", () => {
  it("新增 → 列表（按类型过滤+搜索）→ 修改 → 使用计数 → 删除", async () => {
    const p1 = (await app.inject({ method: "POST", url: "/api/v1/prompts",
      payload: { kind: "prompt", text: "a cyberpunk street at night" } })).json();
    const n1 = (await app.inject({ method: "POST", url: "/api/v1/prompts",
      payload: { kind: "negative", text: "blurry, low quality" } })).json();
    expect(p1.kind).toBe("prompt");
    expect(n1.kind).toBe("negative");

    const list = (await app.inject({ method: "GET", url: "/api/v1/prompts?kind=prompt" })).json();
    expect(list.items.some((i: { id: string }) => i.id === p1.id)).toBe(true);
    const search = (await app.inject({ method: "GET", url: "/api/v1/prompts?q=blurry" })).json();
    expect(search.items.map((i: { id: string }) => i.id)).toEqual([n1.id]);
    const none = (await app.inject({ method: "GET", url: "/api/v1/prompts?q=不存在的内容" })).json();
    expect(none.items).toHaveLength(0);

    const upd = await app.inject({ method: "PUT", url: `/api/v1/prompts/${p1.id}`,
      payload: { text: "a rainy cyberpunk street" } });
    expect(upd.json().ok).toBe(true);
    expect(ctx.store.getPrompt(p1.id)!.text).toContain("rainy");

    const use = (await app.inject({ method: "POST", url: `/api/v1/prompts/${p1.id}/use` })).json();
    expect(use.text).toContain("rainy");
    expect(ctx.store.getPrompt(p1.id)!.use_count).toBe(1);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/prompts/${n1.id}` })).json().ok).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/prompts/${n1.id}` })).statusCode).toBe(404);
  });

  it("非法新增 / 空 text 422；不存在 404", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/prompts",
      payload: { kind: "weird", text: "x" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/v1/prompts",
      payload: { kind: "prompt", text: "  " } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PUT", url: "/api/v1/prompts/nope",
      payload: { text: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/prompts/nope/use" })).statusCode).toBe(404);
  });
});

async function png64(): Promise<string> {
  const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#9c6" } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

describe("POST /api/v1/describe（图像反推提示词）", () => {
  it("返回反推文本", async () => {
    const img = await png64();
    ctx.describe.describe = async () => "a orange cat wearing a hat, soft light";
    const res = await app.inject({ method: "POST", url: "/api/v1/describe",
      payload: { image: img } });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("orange cat");
  });

  it("缺图 422；失败 500 带信息", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/describe", payload: {} })).statusCode).toBe(422);
    ctx.describe.describe = async () => { throw new Error("编码器未加载"); };
    const r = await app.inject({ method: "POST", url: "/api/v1/describe",
      payload: { image: "data:image/png;base64,aaaaaaaaaaaaaaaa" } });
    expect(r.statusCode).toBe(500);
    expect(r.json().message).toContain("编码器未加载");
  });
});

describe("批量删除任务（存在项分支）", () => {
  it("删除存在的任务并统计", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/jobs",
      payload: { prompt: "batch del", width: 512, height: 512, steps: 4 } });
    const jobId = created.json().job_id;
    const r = await app.inject({ method: "POST", url: "/api/v1/jobs/batch-delete",
      payload: { ids: [jobId, "job_missing"] } });
    expect(r.json().message).toContain("已删除 1 个");
    expect((await app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}` })).statusCode).toBe(404);
  });
});
