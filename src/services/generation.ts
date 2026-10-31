/**
 * 生成服务：编排「解析参数 → 上传参考图 → 构建工作流 → 提交 → 监听 → 落盘 → 入库」。
 * 引擎依赖以最小接口注入（生产传 ComfyClient，测试传假实现）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import sharp from "sharp";
import type { Store, ImageRow } from "../db/store.js";
import type { EventBus } from "../events/bus.js";
import type { Workflow, OutputImage, WsEvent } from "../comfy/client.js";
import {
  buildWorkflow, normalizeEditPrompt, resolveRefMode,
  type BaseParams, type RefMode,
} from "../workflow/builder.js";
import { decodeImage, newId, outputFilename } from "../util/ids.js";
import { fitReference, resizeToCanvas } from "./refs.js";
import type { AppConfig } from "../config.js";

/** 引擎最小接口（ComfyClient 满足；测试可替换）。 */
export interface EngineLike {
  uploadImage(buf: Buffer, filename: string, mime?: string): Promise<string>;
  submit(workflow: Workflow, clientId: string): Promise<string>;
  listen(
    clientId: string, promptId: string,
    onEvent: (ev: WsEvent) => void, timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string }>;
  history(promptId: string): Promise<{
    status: { status_str: string; completed: boolean };
    outputs: Record<string, { images?: OutputImage[] }>;
  } | null>;
  viewImage(img: OutputImage): Promise<Buffer>;
}

export interface GenerateParams {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  steps: number;
  guidance_scale: number;
  seed: number;
  batch_size: number;
  mode: "txt2img" | "img2img";
  ref_images: string[];   // data URL，有序（第 1 张为画布）
  ref_mode: RefMode;
  strength: number;
  count: number;
  output_subdir?: string;
}

export class GenerationService {
  constructor(
    private readonly engine: EngineLike,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly cfg: AppConfig,
    private readonly shouldCancel: (jobId: string) => boolean = () => false,
  ) {}

  private baseParams(p: GenerateParams, seed: number): BaseParams {
    return {
      prompt: p.prompt, negative: p.negative_prompt,
      width: p.width, height: p.height, steps: p.steps,
      guidance: p.guidance_scale, seed,
      models: {
        transformer: this.cfg.TRANSFORMER_FILE,
        textEncoder: this.cfg.TEXT_ENCODER_FILE,
        vae: this.cfg.VAE_FILE,
      },
    };
  }

  private progress(jobId: string, index: number, count: number): (ev: WsEvent) => void {
    return (ev) => {
      if (ev.type !== "progress") return;
      const d = ev.data as { value: number; max: number };
      const local = d.value / Math.max(1, d.max);
      const overall = Math.round(((index + local) / count) * 96) + 2;
      this.store.updateJob(jobId, { progress: overall, message: "采样中" });
      this.bus.publish(jobId, {
        event: "progress",
        data: { step: index + 1, total: count, percent: overall },
      });
    };
  }

  private outputDir(subdir?: string): string {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.cfg.outputDirAbs, subdir ?? day);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 执行一个任务的全部张数。失败抛错（调度器负责落库 failed）。 */
  async runJob(jobId: string, params: GenerateParams): Promise<void> {
    const count = Math.max(1, params.count);
    const created: ImageRow[] = [];

    for (let index = 0; index < count; index++) {
      if (this.shouldCancel(jobId)) {
        this.store.updateJob(jobId, { status: "canceled", message: "已取消" });
        this.bus.publish(jobId, { event: "done", data: { status: "canceled" } });
        return;
      }
      const record = await this.runOnce(jobId, params, index, count);
      if (record) {
        this.store.insertImage(record);
        created.push(record);
        this.bus.publish(jobId, {
          event: "image",
          data: { id: record.id, url: record.url, seed: record.seed },
        });
      }
    }

    this.store.updateJob(jobId, {
      status: "succeeded", progress: 100, message: "已完成",
      finished_at: new Date().toISOString(),
    });
    this.bus.publish(jobId, {
      event: "done",
      data: { status: "succeeded", count: created.length, images: created.map((r) => ({ url: r.url, seed: r.seed })) },
    });
  }

  private async runOnce(
    jobId: string, p: GenerateParams, index: number, count: number,
  ): Promise<ImageRow> {
    const started = Date.now();
    const seed = p.seed >= 0 ? p.seed + index : randomInt(0, 2 ** 31);

    // 参考图：预处理 + 上传
    const refNames: string[] = [];
    const isImg2Img = p.mode === "img2img" && p.ref_images.length > 0;
    if (isImg2Img) {
      for (let i = 0; i < p.ref_images.length; i++) {
        const { buf, mime } = decodeImage(p.ref_images[i]!);
        const processed = i === 0
          ? await resizeToCanvas(buf, p.width, p.height) // 第 1 张对齐输出画布
          : await fitReference(buf);
        refNames.push(await this.engine.uploadImage(processed, `ref-${jobId}-${i}.png`, mime));
      }
    }

    const resolved = isImg2Img
      ? resolveRefMode(refNames.length, p.ref_mode)
      : ("txt2img" as const);
    let prompt = p.prompt;
    if (resolved === "edit") prompt = normalizeEditPrompt(prompt, refNames.length);

    const workflow = buildWorkflow(
      this.baseParams(p, seed), resolved, refNames, p.strength,
    );
    const promptId = await this.engine.submit(workflow, `imagestudio-${jobId}`);
    const result = await this.engine.listen(
      `imagestudio-${jobId}`, promptId, this.progress(jobId, index, count),
      Math.max(120_000, this.cfg.INFER_TIMEOUT_SECONDS * 1000 - 30_000),
    );
    if (!result.ok) throw new Error(result.error ?? "推理失败");

    const history = await this.engine.history(promptId);
    const outputs = Object.values(history?.outputs ?? {})
      .flatMap((o) => o.images ?? [])
      .filter((im) => im.type !== "temp");
    if (!outputs.length) throw new Error("ComfyUI 输出中未找到图片");
    const buf = await this.engine.viewImage(outputs[0]!);

    const dir = this.outputDir(p.output_subdir);
    const relToData = path.relative(this.cfg.dataDirAbs, dir);
    const file = outputFilename(seed, newId("img").slice(-6));
    fs.writeFileSync(path.join(dir, file), buf);

    const meta = await sharp(buf).metadata();
    return {
      id: newId("img"), job_id: jobId,
      path: path.posix.join(relToData.split(path.sep).join("/"), file),
      url: `/data/${path.posix.join(relToData.split(path.sep).join("/"), file)}`,
      width: meta.width ?? p.width, height: meta.height ?? p.height,
      steps: p.steps, guidance: p.guidance_scale, seed,
      prompt, negative: p.negative_prompt, mode: p.mode,
      ref_mode: p.mode === "img2img" ? resolved : "",
      favorite: 0, flagged: 0,
      elapsed_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    };
  }
}
