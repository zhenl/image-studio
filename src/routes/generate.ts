/**
 * 生成 / 任务 / 预览 / 图库 路由。
 */
import type { FastifyInstance } from "fastify";
import { newId, nowIso } from "../util/ids.js";
import {
  generateRequestSchema, previewRequestSchema, MAX_REF_IMAGES,
} from "./schemas.js";
import type { AppContext } from "../context.js";

export function generateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, scheduler, bus, cfg, calibrator, comfy } = ctx;

  function jobOut(jobId: string): Record<string, unknown> {
    const job = store.getJob(jobId);
    if (!job) return {};
    const { params_json: _p, ...rest } = job;
    return { ...rest, images: store.imagesByJob(jobId) };
  }

  // ---------- 同步出图：阻塞到完成 ----------
  app.post("/generate", async (req, reply) => {
    const parsed = generateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(422).send({ code: "INVALID", message: parsed.error.issues[0]?.message });
    }
    const p = parsed.data;
    const jobId = newId("job");
    store.createJob({
      id: jobId, mode: p.mode, prompt: p.prompt, negative: p.negative_prompt,
      params_json: JSON.stringify({ ...p, ref_count: p.ref_images.length }),
      seed: p.seed, count: p.count, created_at: nowIso(),
    });
    try {
      await withTimeout(
        ctx.generation.runJob(jobId, p as never),
        cfg.INFER_TIMEOUT_SECONDS * 1000,
        "推理超时",
      );
    } catch (err) {
      store.updateJob(jobId, {
        status: "failed", error: (err as Error).message, finished_at: nowIso(),
      });
      return reply.status(500).send({ code: "INFERENCE_ERROR", message: (err as Error).message });
    }
    return jobOut(jobId);
  });

  // ---------- 异步任务 ----------
  app.post("/jobs", async (req, reply) => {
    const parsed = generateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(422).send({ code: "INVALID", message: parsed.error.issues[0]?.message });
    }
    const p = parsed.data;
    const jobId = newId("job");
    store.createJob({
      id: jobId, mode: p.mode, prompt: p.prompt, negative: p.negative_prompt,
      params_json: JSON.stringify({ ...p, ref_count: p.ref_images.length }),
      seed: p.seed, count: p.count, created_at: nowIso(),
    });
    try {
      const position = scheduler.submit(jobId, p as never);
      return reply.status(202).send({ job_id: jobId, status: "queued", position, queue_size: scheduler.queueSize() });
    } catch (err) {
      store.updateJob(jobId, { status: "failed", error: (err as Error).message, finished_at: nowIso() });
      return reply.status(409).send({ code: "BUSY", message: (err as Error).message });
    }
  });

  app.get("/jobs", async (req) => {
    const q = req.query as { limit?: string; status?: string };
    const items = store.listJobs(Number(q.limit ?? 20) || 20, q.status)
      .map(({ params_json: _p, ...rest }) => rest);
    return { items };
  });

  app.get("/jobs/:id", (req, reply) => {
    const job = jobOut((req.params as { id: string }).id);
    if (!job.id) return reply.status(404).send({ code: "NOT_FOUND", message: "任务不存在" });
    return job;
  });

  app.delete("/jobs/:id", (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getJob(id)) return reply.status(404).send({ code: "NOT_FOUND", message: "任务不存在" });
    scheduler.cancel(id);
    store.deleteJob(id);
    return { ok: true, message: "已取消并删除" };
  });

  // ---------- SSE 进度流 ----------
  app.get("/jobs/:id/events", (req, reply) => {
    const id = (req.params as { id: string }).id;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (ev: { event: string; data: unknown }): void => {
      reply.raw.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    };
    const off = bus.subscribe(id, send);
    const job = store.getJob(id);
    if (job && ["succeeded", "failed", "canceled"].includes(job.status)) {
      send({ event: "done", data: { status: job.status } });
      off();
      reply.raw.end();
      return;
    }
    req.raw.on("close", () => { off(); });
  });

  // ---------- 参数估算 ----------
  app.post("/preview", (req) => {
    const parsed = previewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return { code: "INVALID", message: parsed.error.issues[0]?.message };
    }
    const { width, height, steps, batch_size } = parsed.data;
    const mp = (width * height) / 1_000_000;
    const est = calibrator.estimate(width, height, steps, batch_size);
    const warnings: string[] = [];
    if (width % 64 || height % 64) warnings.push("尺寸必须是 64 的整数倍");
    if (mp > 2.25) warnings.push("像素量较大，可能显存不足，建议降低分辨率");
    if (!est.calibrated) {
      warnings.push("本机尚无出图记录，耗时按 RTX 2060 6GB 参考值估算（偏保守），完成首次生成后会自动校准");
    }
    if (est.seconds > cfg.INFER_TIMEOUT_SECONDS) {
      warnings.push(`预计耗时 ${Math.round(est.seconds / 60)} 分钟，超过超时上限 ${Math.round(cfg.INFER_TIMEOUT_SECONDS / 60)} 分钟，任务会被自动取消——请降低分辨率或步数`);
    }
    return {
      estimated_seconds: est.seconds,
      estimated_vram_gb: Math.round((4.6 + mp * 1.5) * 100) / 100,
      megapixels: Math.round(mp * 100) / 100,
      warnings,
      calibrated: est.calibrated,
      samples: est.samples,
      max_ref_images: MAX_REF_IMAGES,
    };
  });

  // ---------- 图库 ----------
  app.get("/gallery", async (req) => {
    const q = req.query as { limit?: string; favorite?: string };
    const items = store.listImages(Number(q.limit ?? 60) || 60, q.favorite === "1");
    return { items };
  });

  app.post("/gallery/:id/favorite", (req, reply) => {
    const id = (req.params as { id: string }).id;
    const on = (req.body as { favorite?: boolean } | null)?.favorite ?? true;
    const img = store.listImages(10_000).find((i) => i.id === id);
    if (!img) return reply.status(404).send({ code: "NOT_FOUND", message: "图片不存在" });
    store.setFavorite(id, on);
    return { ok: true };
  });

  // ---------- 状态 ----------
  app.get("/status", async () => {
    const reachable = await comfy.ping();
    let gpuName: string | null = null;
    let vramTotal: number | null = null;
    if (reachable) {
      try {
        const stats = await comfy.systemStats();
        gpuName = stats.devices[0]?.name ?? null;
        vramTotal = stats.devices[0]
          ? Math.round((stats.devices[0].vram_total / 1024 ** 3) * 100) / 100
          : null;
      } catch { /* 状态展示尽力而为 */ }
    }
    return {
      engine_mode: cfg.ENGINE_MODE,
      loaded: reachable,
      comfyui_url: cfg.COMFYUI_URL,
      gpu_name: gpuName,
      vram_total_gb: vramTotal,
      queue_size: scheduler.queueSize(),
      running_job: scheduler.currentJob(),
    };
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); });
  });
}
