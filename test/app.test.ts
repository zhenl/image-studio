import { describe, it, expect, beforeAll } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const app = buildApp();

describe("GET /", () => {
  it("返回前端页面（HTML）", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Image Studio");
  });
});

describe("GET /api/v1/health", () => {
  it("返回引擎模式与 ComfyUI 地址", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(["mock", "comfy"]).toContain(body.engine_mode);
    expect(body.comfyui_url).toMatch(/^http/);
  });
});

describe("错误处理", () => {
  it("未知路由返回 404 JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("message");
  });
});

describe("ensureDirs（经由 loadConfig 派生路径验证）", () => {
  it("路径派生包含 output 目录", () => {
    const c = loadConfig({});
    expect(c.outputDirAbs).toContain("outputs");
  });
});
