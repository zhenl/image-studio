/**
 * 图像反推提示词：CLIPLoader(qwen_image) → LoadImage → TextGenerate → SaveText。
 * 复用出图的 Qwen3-VL-8B 文本编码器（自带视觉塔），贪心解码，无需额外模型。
 * 移植自 qwenimage-studio 的 describe_image；结果取自 /history 的 text 输出。
 */
import sharp from "sharp";
import type { Workflow, OutputImage } from "../comfy/client.js";
import { decodeImage } from "../util/ids.js";

const DESCRIBE_PROMPT = (
  "Describe this image as a single comma-separated English prompt for an image " +
  "generation model. Cover: main subjects and their details (appearance, clothing, " +
  "pose, expression), colors, background and environment, lighting, composition " +
  "or camera angle, and the overall art style or medium. Output ONLY the prompt, " +
  "no explanations, no quotes, 40-120 words."
);

/** 引擎最小接口（ComfyClient 满足；测试可替换）。 */
export interface DescribeEngineLike {
  uploadImage(buf: Buffer, filename: string, mime?: string): Promise<string>;
  submit(workflow: Workflow, clientId: string): Promise<string>;
  history(promptId: string): Promise<{
    status: { status_str: string; completed: boolean };
    outputs: Record<string, { images?: OutputImage[]; text?: string[] }>;
  } | null>;
}

export interface DescribeOptions {
  maxSide?: number;    // 视觉塔按块计费，长边限 1024：过大只拖慢不增质
  maxLength?: number;  // 生成 token 上限
  timeoutMs?: number;  // 整体超时
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;  // 可注入（测试零等待）
}

export class DescribeService {
  constructor(private readonly engine: DescribeEngineLike) {}

  async describe(
    dataUrl: string,
    clientId: string,
    opts: DescribeOptions = {},
  ): Promise<string> {
    const { maxSide = 1024, maxLength = 256, timeoutMs = 300_000,
            pollIntervalMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;

    // 预处理：长边限 maxSide、32 对齐、统一 PNG
    const { buf } = decodeImage(dataUrl);
    const img = sharp(buf, { failOn: "none" });
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const scale = maxSide / Math.max(w, h);
    const processed = scale < 1 && w > 0 && h > 0
      ? await img.resize(Math.max(32, Math.round((w * scale) / 32) * 32),
                         Math.max(32, Math.round((h * scale) / 32) * 32)).png().toBuffer()
      : await img.png().toBuffer();

    const name = await this.engine.uploadImage(processed, `desc-${Date.now()}.png`);
    const workflow: Workflow = {
      "1": { class_type: "CLIPLoader", inputs: {
        clip_name: this.clipName, type: "qwen_image", device: "default" } },
      "2": { class_type: "LoadImage", inputs: { image: name } },
      "3": { class_type: "TextGenerate", inputs: {
        clip: ["1", 0], prompt: DESCRIBE_PROMPT, image: ["2", 0],
        max_length: Math.max(64, Math.min(maxLength, 1024)),
        sampling_mode: "off", thinking: false,
        use_default_template: true, mtp: "off" } },
      // TextGenerate 不是输出节点，必须挂 SaveText 否则 ComfyUI 拒绝
      "4": { class_type: "SaveText", inputs: {
        text: ["3", 0], filename_prefix: "desc/api", format: "txt" } },
    };

    const promptId = await this.engine.submit(workflow, clientId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = await this.engine.history(promptId);
      if (record) {
        const state = record.status.status_str;
        if (state === "success") {
          const text = Object.values(record.outputs)
            .flatMap((o) => o.text ?? []).join("\n").trim();
          if (!text) throw new Error("反推结果为空（TextGenerate 无文本输出）");
          return text;
        }
        if (state === "error") throw new Error("ComfyUI 文本生成失败（详见服务日志）");
      }
      if (Date.now() > deadline) throw new Error(`图像反推超时（>${Math.round(timeoutMs / 1000)}s），请重试`);
      await sleep(pollIntervalMs);
    }
  }

  /** 文本编码器文件名（basename，容忍配置里的子目录前缀）——测试可覆写。 */
  clipName: string = "";
}

/** 便捷工厂：从配置初始化 clipName。 */
export function createDescribeService(
  engine: DescribeEngineLike, textEncoderFile: string,
): DescribeService {
  const svc = new DescribeService(engine);
  svc.clipName = textEncoderFile.split(/[\\/]/).pop() ?? textEncoderFile;
  return svc;
}
