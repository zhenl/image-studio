/**
 * 模型管理：以 ComfyUI /object_info 为权威来源的列表与选择。
 * 选择即时生效（写入运行时配置）并持久化到 .env。
 */
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext } from "../context.js";

export function modelRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { comfy, cfg } = ctx;

  const quantOf = (name: string): string =>
    name.toLowerCase().endsWith(".gguf") ? name.split("-").pop()!.replace(/\.gguf$/i, "") : "safetensors";

  const mark = (files: string[] | null, current: string) =>
    (files ?? []).map((name) => ({ name, quant: quantOf(name), current: name === current }));

  app.get("/models/list", async () => {
    const diffusion = await comfy.listNodeFiles(["UnetLoaderGGUF", "UNETLoader"], "unet_name");
    const textEncoders = await comfy.listNodeFiles(["CLIPLoader"], "clip_name");
    const vaes = await comfy.listNodeFiles(["VAELoader"], "vae_name");
    // UNETLoader 会把 text_encoders/ vae/ 等其它类别也列出来，剔除
    const filtered = diffusion?.filter(
      (s) => s.split("/")[0] !== "text_encoders" && s.split("/")[0] !== "vae",
    ) ?? null;
    const source = diffusion === null && textEncoders === null && vaes === null
      ? "local" : "comfy";
    return {
      source,
      items: mark(filtered, path.basename(cfg.TRANSFORMER_FILE)),
      text_encoders: mark(textEncoders, path.basename(cfg.TEXT_ENCODER_FILE)),
      vaes: mark(vaes, path.basename(cfg.VAE_FILE)),
      current: path.basename(cfg.TRANSFORMER_FILE),
    };
  });

  const selectSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    text_encoder: z.string().min(1).max(200).optional(),
    vae: z.string().min(1).max(200).optional(),
  });

  function persistEnv(key: string, value: string): void {
    try {
      const file = cfg.envFileAbs;
      const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n") : [];
      const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
      if (idx >= 0) lines[idx] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
      fs.writeFileSync(file, lines.join("\n"), "utf-8");
    } catch (err) {
      console.error("[模型切换] 写入 .env 失败:", (err as Error).message);
    }
  }

  app.post("/models/select", async (req, reply) => {
    const parsed = selectSchema.safeParse(req.body);
    if (!parsed.success || (!parsed.data.name && !parsed.data.text_encoder && !parsed.data.vae)) {
      return reply.status(422).send({ code: "INVALID", message: "未指定要切换的模型" });
    }
    const { name, text_encoder: te, vae } = parsed.data;
    const changes: string[] = [];

    // 校验：必须在 ComfyUI 可见列表中（防拼错文件名静默失败）
    if (name) {
      const allowed = (await comfy.listNodeFiles(["UnetLoaderGGUF", "UNETLoader"], "unet_name"))
        ?.filter((s) => s.split("/")[0] !== "text_encoders" && s.split("/")[0] !== "vae") ?? [];
      if (!allowed.includes(name)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: `ComfyUI 未提供权重：${name}` });
      }
      if (name !== path.basename(cfg.TRANSFORMER_FILE)) {
        cfg.TRANSFORMER_FILE = name;
        persistEnv("TRANSFORMER_FILE", name);
        changes.push(name);
      }
    }
    if (te) {
      const allowed = (await comfy.listNodeFiles(["CLIPLoader"], "clip_name")) ?? [];
      if (!allowed.includes(te)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: `ComfyUI 未提供文本编码器：${te}` });
      }
      if (te !== path.basename(cfg.TEXT_ENCODER_FILE)) {
        cfg.TEXT_ENCODER_FILE = te;
        persistEnv("TEXT_ENCODER_FILE", te);
        changes.push(te);
      }
    }
    if (vae) {
      const allowed = (await comfy.listNodeFiles(["VAELoader"], "vae_name")) ?? [];
      if (!allowed.includes(vae)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: `ComfyUI 未提供 VAE：${vae}` });
      }
      if (vae !== path.basename(cfg.VAE_FILE)) {
        cfg.VAE_FILE = vae;
        persistEnv("VAE_FILE", vae);
        changes.push(vae);
      }
    }
    if (!changes.length) return { ok: true, message: "已是当前选择，无需切换" };
    return { ok: true, message: `已切换：${changes.join("、")}（下一张图生效）` };
  });
}
