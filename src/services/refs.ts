/**
 * 参考图预处理：限制长边（32 的倍数），防手机原图撑爆视觉序列与 latent。
 */
import sharp from "sharp";

export const MAX_REF_SIDE = 1536;

export async function fitReference(buf: Buffer, maxSide = MAX_REF_SIDE): Promise<Buffer> {
  const img = sharp(buf, { failOn: "none" });
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const scale = maxSide / Math.max(w, h);
  if (scale >= 1 || w === 0 || h === 0) {
    // 已在限内：仍输出 png 统一格式
    return img.png().toBuffer();
  }
  const nw = Math.max(32, Math.round((w * scale) / 32) * 32);
  const nh = Math.max(32, Math.round((h * scale) / 32) * 32);
  return img.resize(nw, nh).png().toBuffer();
}

/** 传统重绘：把参考图缩放到目标输出画布尺寸。 */
export async function resizeToCanvas(
  buf: Buffer, width: number, height: number,
): Promise<Buffer> {
  const img = sharp(buf, { failOn: "none" });
  const meta = await img.metadata();
  if (meta.width === width && meta.height === height) {
    return img.png().toBuffer();
  }
  return img.resize(width, height).png().toBuffer();
}
