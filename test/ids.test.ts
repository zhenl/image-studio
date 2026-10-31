import { describe, it, expect } from "vitest";
import { newId, nowIso, outputFilename, decodeImage } from "../src/util/ids.js";

describe("newId", () => {
  it("带前缀且每次不同", () => {
    const a = newId("job");
    const b = newId("job");
    expect(a).toMatch(/^job_[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe("nowIso", () => {
  it("返回合法 ISO 时间", () => {
    expect(() => new Date(nowIso())).not.toThrow();
  });
});

describe("outputFilename", () => {
  it("格式：日期-时间_种子_哈希.png", () => {
    expect(outputFilename(12345, "abcdef")).toMatch(
      /^\d{8}-\d{6}_12345_abcdef\.png$/,
    );
  });
});

describe("decodeImage", () => {
  it("解析 data URL（含 MIME）", () => {
    const png = Buffer.from("fake").toString("base64");
    const r = decodeImage(`data:image/png;base64,${png}`);
    expect(r.mime).toBe("image/png");
    expect(r.buf.toString()).toBe("fake");
  });

  it("裸 base64 默认按 png 处理", () => {
    const r = decodeImage(Buffer.from("hi").toString("base64"));
    expect(r.mime).toBe("image/png");
    expect(r.buf.toString()).toBe("hi");
  });
});
