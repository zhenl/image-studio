/**
 * 任务与图片的 ID / 时间工具（纯函数，便于测试）。
 */
import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** ISO 时间戳（本地时区）。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 生成输出文件名：日期-时间_种子_哈希.png */
export function outputFilename(seed: number, hash: string): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}_${seed}_${hash}.png`;
}

/** data URL / 裸 base64 → Buffer 与 MIME 类型。 */
export function decodeImage(dataUrl: string): { buf: Buffer; mime: string } {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (m) return { buf: Buffer.from(m[2]!, "base64"), mime: m[1]! };
  return { buf: Buffer.from(dataUrl, "base64"), mime: "image/png" };
}
