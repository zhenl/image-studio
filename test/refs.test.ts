import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { fitReference, resizeToCanvas, MAX_REF_SIDE } from "../src/services/refs.js";

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#f00" } })
    .png().toBuffer();
}

describe("fitReference", () => {
  it("超长边参考图缩到 1536 内且为 32 倍数", async () => {
    const out = await fitReference(await png(3000, 4000));
    const meta = await sharp(out).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(MAX_REF_SIDE + 31);
    expect(meta.width! % 32).toBe(0);
    expect(meta.height! % 32).toBe(0);
  });

  it("小图保持原尺寸（仅统一为 png）", async () => {
    const out = await fitReference(await png(256, 128));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(128);
    expect(meta.format).toBe("png");
  });
});

describe("resizeToCanvas", () => {
  it("缩放到目标画布尺寸", async () => {
    const out = await resizeToCanvas(await png(640, 640), 768, 1024);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([768, 1024]);
  });

  it("尺寸一致时直接输出", async () => {
    const buf = await png(512, 512);
    const out = await resizeToCanvas(buf, 512, 512);
    expect((await sharp(out).metadata()).width).toBe(512);
  });
});
