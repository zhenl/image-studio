import { describe, it, expect } from "vitest";
import { config } from "../src/config.js";

describe("config 单例", () => {
  it("模块级单例完成加载并暴露全部派生路径", () => {
    expect(config.projectRoot).toContain("image-studio");
    expect(config.COMFYUI_URL).toMatch(/^http/);
    expect(typeof config.PORT).toBe("number");
  });
});
