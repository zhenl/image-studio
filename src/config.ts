/**
 * 全局配置：环境变量 > .env > 默认值（zod 校验 + 类型安全）。
 */
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";

const projectRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

const schema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(8030),
  ENGINE_MODE: z.enum(["mock", "comfy"]).default("comfy"),
  COMFYUI_URL: z.string().url().default("http://127.0.0.1:8188"),
  COMFYUI_SHARED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  TRANSFORMER_FILE: z.string().default("qwen-image-2.1-UC-Q4_K_M.gguf"),
  TEXT_ENCODER_FILE: z
    .string()
    .default("qwen3vl_8b_int8_convrot.safetensors"),
  VAE_FILE: z.string().default("qwen_image_2.1_vae_bf16.safetensors"),
  DEFAULT_WIDTH: z.coerce.number().default(768),
  DEFAULT_HEIGHT: z.coerce.number().default(768),
  DEFAULT_STEPS: z.coerce.number().default(8),
  DEFAULT_GUIDANCE: z.coerce.number().default(4.0),
  MAX_BATCH: z.coerce.number().default(4),
  INFER_TIMEOUT_SECONDS: z.coerce.number().default(2400),
  MAX_QUEUE_SIZE: z.coerce.number().default(20),
  DATA_DIR: z.string().default("data"),
  OUTPUT_DIR: z.string().default("data/outputs"),
  DB_PATH: z.string().default("data/app.db"),
  MAX_OUTPUT_DIR_GB: z.coerce.number().default(50),
});

export type RawConfig = z.infer<typeof schema>;

export interface AppConfig extends RawConfig {
  projectRoot: string;
  dataDirAbs: string;
  outputDirAbs: string;
  dbPathAbs: string;
}

/** 解析环境变量（可注入，便于测试）。默认读取 process.env + .env。 */
export function loadConfig(
  env: Record<string, string | undefined> = {},
  dotenvPath = path.join(projectRoot, ".env"),
): AppConfig {
  const merged: Record<string, string | undefined> = {
    ...parseDotenv(dotenvPath),
    ...env,
  };
  const parsed = schema.parse(merged);
  return {
    ...parsed,
    projectRoot,
    dataDirAbs: path.resolve(projectRoot, parsed.DATA_DIR),
    outputDirAbs: path.resolve(projectRoot, parsed.OUTPUT_DIR),
    dbPathAbs: path.resolve(projectRoot, parsed.DB_PATH),
  };
}

/** 解析 .env 文件（不存在或不可读则返回空对象）。 */
function parseDotenv(file: string): Record<string, string> {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(file)) return {};
    const dotenv = require("dotenv") as typeof import("dotenv");
    return dotenv.parse(fs.readFileSync(file));
  } catch {
    return {};
  }
}

/** 单例配置（应用运行期使用；测试用 loadConfig 显式注入）。 */
export const config: AppConfig = loadConfig();
