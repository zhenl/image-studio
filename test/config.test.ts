import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("提供全部默认值", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(8030);
    expect(c.ENGINE_MODE).toBe("comfy");
    expect(c.COMFYUI_URL).toBe("http://127.0.0.1:8188");
    expect(c.COMFYUI_SHARED).toBe(true);
    expect(c.MAX_BATCH).toBe(4);
    expect(c.TRANSFORMER_FILE).toContain("Q4_K_M");
  });

  it("环境变量覆盖默认值（字符串数字被 coerce）", () => {
    const c = loadConfig({ PORT: "9001", ENGINE_MODE: "mock", MAX_BATCH: "2" });
    expect(c.PORT).toBe(9001);
    expect(c.ENGINE_MODE).toBe("mock");
    expect(c.MAX_BATCH).toBe(2);
  });

  it("COMFYUI_SHARED=false 解析为布尔 false", () => {
    expect(loadConfig({ COMFYUI_SHARED: "false" }).COMFYUI_SHARED).toBe(false);
    expect(loadConfig({ COMFYUI_SHARED: "true" }).COMFYUI_SHARED).toBe(true);
  });

  it("派生路径基于项目根解析为绝对路径", () => {
    const c = loadConfig({ DATA_DIR: "data" });
    expect(path.isAbsolute(c.dataDirAbs)).toBe(true);
    expect(c.dataDirAbs.endsWith("/data")).toBe(true);
    expect(c.projectRoot).toBe(path.resolve(import.meta.dirname, ".."));
  });

  it("非法 ENGINE_MODE 被拒绝", () => {
    expect(() => loadConfig({ ENGINE_MODE: "local" })).toThrow();
  });

  it("非法 COMFYUI_URL 被拒绝", () => {
    expect(() => loadConfig({ COMFYUI_URL: "not-a-url" })).toThrow();
  });

  it("从 .env 文件读取默认值，env 显式传入优先", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "is-env-"));
    const file = path.join(tmp, ".env");
    fs.writeFileSync(file, "PORT=7001\nENGINE_MODE=mock\n");
    const c = loadConfig({ PORT: "7002" }, file);
    expect(c.PORT).toBe(7002);      // env 覆盖 .env
    expect(c.ENGINE_MODE).toBe("mock"); // .env 覆盖默认
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it(".env 路径不可读（目录）时回退默认值", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "is-env-"));
    const c = loadConfig({ PORT: "7003" }, tmp); // 目录 → parse 抛错 → 默认
    expect(c.PORT).toBe(7003);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
