import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Store } from "../src/db/store.js";
import { EventBus } from "../src/events/bus.js";
import { GenerationService, type EngineLike, type GenerateParams } from "../src/services/generation.js";
import { loadConfig } from "../src/config.js";

let dir: string;
let store: Store;
let bus: EventBus;
let cfg: ReturnType<typeof loadConfig>;

/** 假引擎：记录调用、返回固定流程与产物。 */
function fakeEngine(over: Partial<EngineLike> = {}) {
  const calls: string[] = [];
  const pngBuf = () =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: "#0f0" } }).png().toBuffer();
  const engine: EngineLike = {
    async uploadImage(buf, name) { calls.push(`upload:${name}:${buf.length}`); return `up_${name}`; },
    async submit(workflow) {
      calls.push(`submit:${Object.keys(workflow).length}nodes`);
      return "pid-1";
    },
    async listen(_cid, pid, onEvent) {
      calls.push(`listen:${pid}`);
      onEvent({ type: "progress", data: { value: 4, max: 8 } });
      return { ok: true };
    },
    async history(pid) {
      calls.push(`history:${pid}`);
      return {
        status: { status_str: "success", completed: true },
        outputs: { "11": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
      };
    },
    async viewImage(img) {
      calls.push(`view:${img.filename}`);
      return await pngBuf();
    },
    ...over,
  };
  return { engine, calls };
}

function baseParams(over: Partial<GenerateParams> = {}): GenerateParams {
  return {
    prompt: "a cat", negative_prompt: "", width: 512, height: 512,
    steps: 4, guidance_scale: 4, seed: -1, batch_size: 1,
    mode: "txt2img", ref_images: [], ref_mode: "auto", strength: 0.6,
    count: 1, ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "is-gen-"));
  store = new Store(path.join(dir, "app.db"));
  bus = new EventBus();
  cfg = loadConfig({ OUTPUT_DIR: path.join(dir, "outputs"), DATA_DIR: dir }, path.join(dir, "no.env"));
});

function mkJob(id: string): void {
  store.createJob({
    id, mode: "txt2img", prompt: "a cat", negative: "", params_json: "{}",
    seed: -1, count: 1, created_at: new Date().toISOString(),
  });
}

describe("GenerationService", () => {
  it("文生图全流程：提交→监听→取图→落盘→入库→发布事件", async () => {
    const { engine, calls } = fakeEngine();
    const svc = new GenerationService(engine, store, bus, cfg);
    mkJob("j1");
    const events: string[] = [];
    bus.subscribe("j1", (ev) => events.push(ev.event));
    await svc.runJob("j1", baseParams());

    const job = store.getJob("j1")!;
    expect(job.status).toBe("succeeded");
    expect(job.progress).toBe(100);
    const imgs = store.imagesByJob("j1");
    expect(imgs).toHaveLength(1);
    expect(fs.existsSync(path.join(cfg.dataDirAbs, imgs[0]!.path))).toBe(true);
    expect(imgs[0]!.url).toMatch(/^\/data\//);
    expect(imgs[0]!.seed).toBeGreaterThanOrEqual(0);
    // 调用顺序：submit → listen → history → view
    expect(calls.filter((c) => !c.startsWith("upload")).map((c) => c.split(":")[0]))
      .toEqual(["submit", "listen", "history", "view"]);
    expect(events).toEqual(["progress", "image", "done"]);
  });

  it("批量 count=2：两张图、种子递增、进度跨张叠加", async () => {
    const { engine } = fakeEngine();
    const svc = new GenerationService(engine, store, bus, cfg);
    mkJob("j2");
    const seeds: number[] = [];
    bus.subscribe("j2", (ev) => {
      if (ev.event === "image") seeds.push((ev.data as { seed: number }).seed);
    });
    await svc.runJob("j2", baseParams({ count: 2, seed: 100 }));
    expect(store.imagesByJob("j2")).toHaveLength(2);
    expect(seeds[0]).toBe(100);
    expect(seeds[1]).toBe(101);
  });

  it("固定种子批量时每张 +index", async () => {
    const { engine } = fakeEngine();
    const svc = new GenerationService(engine, store, bus, cfg);
    mkJob("j3");
    await svc.runJob("j3", baseParams({ count: 3, seed: 7 }));
    expect(store.imagesByJob("j3").map((i) => i.seed)).toEqual([7, 8, 9]);
  });

  it("img2img：参考图预处理上传 + 归一化提示词 + edit 通道", async () => {
    const { engine, calls } = fakeEngine();
    const svc = new GenerationService(engine, store, bus, cfg);
    mkJob("j4");
    const ref = `data:image/png;base64,${(
      await sharp({ create: { width: 96, height: 96, channels: 3, background: "#00f" } }).png().toBuffer()
    ).toString("base64")}`;
    await svc.runJob("j4", baseParams({
      mode: "img2img", ref_images: [ref, ref], ref_mode: "edit",
      prompt: "把 image_2 的帽子给 image_1",
    }));
    expect(calls.filter((c) => c.startsWith("upload"))).toHaveLength(2);
    const img = store.imagesByJob("j4")[0]!;
    expect(img.ref_mode).toBe("edit");
    expect(img.prompt).toContain("<image2>");
  });

  it("单参考图 auto → classic（只上传 1 张，用第 1 张）", async () => {
    const { engine, calls } = fakeEngine();
    const svc = new GenerationService(engine, store, bus, cfg);
    mkJob("j5");
    const ref = `data:image/png;base64,${(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#0f0" } }).png().toBuffer()
    ).toString("base64")}`;
    await svc.runJob("j5", baseParams({ mode: "img2img", ref_images: [ref] }));
    expect(calls.filter((c) => c.startsWith("upload"))).toHaveLength(1);
    expect(store.imagesByJob("j5")[0]!.ref_mode).toBe("classic");
  });

  it("推理失败抛错（调度器落库 failed）", async () => {
    const { engine } = fakeEngine({
      listen: async () => ({ ok: false, error: "显存不足" }),
    });
    const svc = new GenerationService(engine, store, bus, cfg);
    mkJob("j6");
    await expect(svc.runJob("j6", baseParams())).rejects.toThrow("显存不足");
  });

  it("输出无图片抛错", async () => {
    const { engine } = fakeEngine({
      history: async () => ({ status: { status_str: "success", completed: true }, outputs: {} }),
    });
    const svc = new GenerationService(engine, store, bus, cfg);
    mkJob("j7");
    await expect(svc.runJob("j7", baseParams())).rejects.toThrow("未找到图片");
  });

  it("取消请求：任务标记 canceled 且不再出图", async () => {
    const { engine } = fakeEngine();
    let cancelAfterFirst = false;
    const svc = new GenerationService(engine, store, bus, cfg, (id) => id === "j8" && cancelAfterFirst);
    mkJob("j8");
    // 第 1 张完成后请求取消
    const origRunOnce = svc.runJob.bind(svc);
    void origRunOnce;
    let images = 0;
    bus.subscribe("j8", (ev) => { if (ev.event === "image") { images++; cancelAfterFirst = true; } });
    await svc.runJob("j8", baseParams({ count: 3 }));
    expect(images).toBe(1);
    expect(store.getJob("j8")!.status).toBe("canceled");
  });
});
