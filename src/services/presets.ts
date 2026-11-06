/**
 * 模型预设：一套配置带齐模型三件 + 参数约定（步数/引导系数）。
 * 免去逐项选模型后还要记着改参数的坑（turbo 必须 CFG=1/8 步）。
 */
import type { AppConfig } from "../config.js";

export interface ModelPreset {
  id: string;
  label: string;
  description: string;
  files: { transformer: string; textEncoder: string; vae: string };
  defaults: { steps: number; guidance: number };
  hint: string;
}

export const PRESETS: ModelPreset[] = [
  {
    id: "qwen-2.1",
    label: "Qwen-Image 2.1（主力·全参数）",
    description: "20B Q4_K_M 量化，质量最高，编辑/文生图约 2 分钟/张",
    files: {
      transformer: "qwen-image-2.1-UC-Q4_K_M.gguf",
      textEncoder: "qwen3vl_8b_int8_convrot.safetensors",
      vae: "qwen_image_2.1_vae_bf16.safetensors",
    },
    defaults: { steps: 8, guidance: 4.0 },
    hint: "引导系数可调（>1 负面提示词生效）",
  },
  {
    id: "qwen-2.1-turbo",
    label: "Qwen-Image 2.1 Turbo（快·保留编辑）",
    description: "int8 convrot 量化 + 8 步蒸馏，文生图 22s / 编辑 37s，质量接近主力",
    files: {
      transformer: "qwen-image-2.1-turbo-int8_convrot.safetensors",
      textEncoder: "qwen3vl_8b_int8_convrot.safetensors",
      vae: "qwen_image_2.1_vae_bf16.safetensors",
    },
    defaults: { steps: 8, guidance: 1.0 },
    hint: "蒸馏约定：固定 CFG=1（负面不生效）、8 步即全质量",
  },
];

export function detectPreset(cfg: AppConfig): string {
  const hit = PRESETS.find((p) => p.files.transformer === cfg.TRANSFORMER_FILE
    && p.files.textEncoder === cfg.TEXT_ENCODER_FILE && p.files.vae === cfg.VAE_FILE);
  return hit?.id ?? "custom";
}
