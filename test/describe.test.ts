import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { createDescribeService, type DescribeEngineLike } from "../src/services/describe.js";

async function png64(width = 800, height = 1200): Promise<string> {
  const buf = await sharp({ create: { width, height, channels: 3, background: "#48c" } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function makeEngine(over: Partial<DescribeEngineLike> = {}) {
  const calls: string[] = [];
  const engine: DescribeEngineLike = {
    async uploadImage(buf, name) {
      calls.push(`upload:${name}:${buf.length}`);
      return `up_${name}`;
    },
    async submit(workflow) {
      calls.push(`submit:${Object.keys(workflow).length}`);
      return "desc-pid";
    },
    async history() {
      calls.push("history");
      return {
        status: { status_str: "success", completed: true },
        outputs: { "4": { text: ["a orange cat wearing a hat, sunny window, soft light"] } },
      };
    },
    ...over,
  };
  return { engine, calls };
}

describe("DescribeService", () => {
  it("全流程：预处理上传 → 工作流 → 轮询取文本", async () => {
    const { engine, calls } = makeEngine();
    const svc = createDescribeService(engine, "text_encoders/qwen3vl_8b_int8_convrot.safetensors");
    const text = await svc.describe(await png64(), "client", { sleep: async () => {} });
    expect(text).toContain("orange cat");
    // CLIPLoader 用 basename
    expect(calls.join()).toContain("submit:4");
    // 长边 1200 → 缩到 1024 内
    const uploadCall = calls.find((c) => c.startsWith("upload:"))!;
    const size = Number(uploadCall.split(":")[2]);
    expect(size).toBeGreaterThan(0);
  });

  it("大图被缩放（上传 buffer 小于原图）", async () => {
    const { engine, calls } = makeEngine();
    const svc = createDescribeService(engine, "te.safetensors");
    const raw = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#000" } }).png().toBuffer();
    const big64 = `data:image/png;base64,${raw.toString("base64")}`;
    await svc.describe(big64, "c", { sleep: async () => {} });
    const uploaded = Number(calls.find((c) => c.startsWith("upload:"))!.split(":")[2]);
    expect(uploaded).toBeLessThan(raw.length);
  });

  it("history 未完成时轮询重试后成功", async () => {
    let n = 0;
    const { engine } = makeEngine({
      history: async () => {
        n++;
        if (n < 3) return null;
        return {
          status: { status_str: "success", completed: true },
          outputs: { "4": { text: ["retried ok"] } },
        };
      },
    });
    const svc = createDescribeService(engine, "te.safetensors");
    const text = await svc.describe(await png64(64, 64), "c", { sleep: async () => {} });
    expect(text).toBe("retried ok");
    expect(n).toBe(3);
  });

  it("执行失败抛错", async () => {
    const { engine } = makeEngine({
      history: async () => ({ status: { status_str: "error", completed: true }, outputs: {} }),
    });
    const svc = createDescribeService(engine, "te.safetensors");
    await expect(svc.describe(await png64(64, 64), "c", { sleep: async () => {} }))
      .rejects.toThrow("文本生成失败");
  });

  it("成功但无文本输出抛错", async () => {
    const { engine } = makeEngine({
      history: async () => ({ status: { status_str: "success", completed: true }, outputs: {} }),
    });
    const svc = createDescribeService(engine, "te.safetensors");
    await expect(svc.describe(await png64(64, 64), "c", { sleep: async () => {} }))
      .rejects.toThrow("反推结果为空");
  });

  it("超时抛错", async () => {
    const { engine } = makeEngine({ history: async () => null });
    const svc = createDescribeService(engine, "te.safetensors");
    await expect(svc.describe(await png64(64, 64), "c", {
      timeoutMs: 10, pollIntervalMs: 5,
      sleep: async () => { await new Promise((r) => setTimeout(r, 6)); },
    })).rejects.toThrow("超时");
  });
});
