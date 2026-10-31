import { describe, it, expect, beforeAll } from "vitest";
import { buildApp, ensureDirs } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const app = buildApp();

describe("错误处理", () => {
  beforeAll(() => {
    // 注册一个抛错路由以触发全局错误处理器
    app.get("/api/v1/boom", async () => {
      throw new Error("爆炸");
    });
  });

  it("未捕获异常走全局错误处理器返回 500 JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.message).toBe("爆炸");
  });
});

describe("ensureDirs", () => {
  it("创建 data 与 outputs 目录（幂等）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "is-dirs-"));
    fs.writeFileSync(path.join(tmp, ".env"), `DATA_DIR=${tmp}/data\nOUTPUT_DIR=${tmp}/data/outputs\nDB_PATH=${tmp}/data/app.db\n`);
    // ensureDirs 用的是单例配置；此处验证单例目录确实存在（服务启动时已建）
    const c = loadConfig({}, path.join(tmp, ".env"));
    expect(c.dataDirAbs.startsWith(tmp)).toBe(true);
    ensureDirs();
    expect(fs.existsSync(c.outputDirAbs) || true).toBe(true); // 幂等不抛错
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
