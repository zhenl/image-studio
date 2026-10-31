/**
 * 请求校验 schema（zod）——对应 Python 版 pydantic 的 GenerateRequest。
 */
import { z } from "zod";
import { loadConfig } from "../config.js";

const d = loadConfig({});

export const MAX_REF_IMAGES = 9;

export const generateRequestSchema = z.object({
  prompt: z.string().trim().min(1, "提示词不能为空"),
  negative_prompt: z.string().default(""),
  width: z.number().int().min(64).max(2048).refine((v) => v % 64 === 0, "宽必须是 64 的整数倍"),
  height: z.number().int().min(64).max(2048).refine((v) => v % 64 === 0, "高必须是 64 的整数倍"),
  steps: z.number().int().min(1).max(100).default(d.DEFAULT_STEPS),
  guidance_scale: z.number().min(0).max(20).default(d.DEFAULT_GUIDANCE),
  seed: z.number().int().default(-1),
  batch_size: z.number().int().min(1).max(d.MAX_BATCH).default(1),
  mode: z.enum(["txt2img", "img2img"]).default("txt2img"),
  ref_images: z.array(z.string().min(8)).max(MAX_REF_IMAGES).default([]),
  ref_mode: z.enum(["classic", "edit", "auto"]).default("auto"),
  strength: z.number().min(0).max(1).default(0.6),
  channel: z.enum(["auto", "local", "remote"]).default("auto"),
}).transform((v) => ({ ...v, count: v.batch_size }));

export const previewRequestSchema = z.object({
  width: z.number().int().min(64).max(2048),
  height: z.number().int().min(64).max(2048),
  steps: z.number().int().min(1).max(100),
  batch_size: z.number().int().min(1).max(d.MAX_BATCH).default(1),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type PreviewRequest = z.infer<typeof previewRequestSchema>;
