import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.js";
import { Calibrator, FALLBACK_K } from "../src/services/calibration.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "is-cal-"));
  store = new Store(path.join(dir, "app.db"));
});

function addImage(w: number, h: number, steps: number, elapsedMs: number, id: string): void {
  store.createJob({
    id: `j-${id}`, mode: "txt2img", prompt: "p", negative: "",
    params_json: "{}", seed: -1, count: 1, created_at: new Date().toISOString(),
  });
  store.insertImage({
    id, job_id: `j-${id}`, path: "x", url: "x", width: w, height: h,
    steps, guidance: 4, seed: 1, prompt: "p", negative: "", mode: "txt2img",
    ref_mode: "", favorite: 0, flagged: 0, elapsed_ms: elapsedMs,
    created_at: new Date().toISOString(),
  });
}

describe("Calibrator", () => {
  it("无历史 → 回退保守参考值并标注未校准", () => {
    const cal = new Calibrator(store);
    const r = cal.estimate(1024, 1024, 20, 1);
    expect(r.calibrated).toBe(false);
    expect(r.samples).toBe(0);
    // 260 s/步/MP × 20 步 × 1.05MP + 180s 开销
    expect(r.seconds).toBeCloseTo(260 * 20 * 1.048576 + 180, 1);
  });

  it("有历史 → 用本机中位数系数校准（无固定开销）", () => {
    // 两台"机器"各一条：10s 与 30s / (8步 × 0.59MP)
    addImage(768, 768, 8, 10_000, "a");
    addImage(768, 768, 8, 30_000, "b");
    const cal = new Calibrator(store);
    const r = cal.estimate(768, 768, 8, 1);
    expect(r.calibrated).toBe(true);
    expect(r.samples).toBe(2);
    const mp = 0.589824;
    expect(r.seconds).toBeCloseTo(20 / (8 * mp) * 8 * mp, 0); // 中位数 20s 的等比换算
  });

  it("缓存 30 秒内不重查数据库", () => {
    addImage(768, 768, 8, 10_000, "a");
    const cal = new Calibrator(store);
    const t0 = 1_000_000;
    cal.calibrate(t0);
    addImage(768, 768, 8, 99_000, "b"); // 新样本
    const cached = cal.calibrate(t0 + 10_000);
    expect(cached.samples).toBe(1); // 仍用缓存
    const fresh = cal.calibrate(t0 + 31_000);
    expect(fresh.samples).toBe(2); // TTL 过期重查
  });

  it("无效记录（elapsed=0）不参与", () => {
    addImage(768, 768, 8, 0, "bad");
    const cal = new Calibrator(store);
    expect(cal.calibrate().samples).toBe(0);
    expect(cal.calibrate().k).toBe(FALLBACK_K);
  });

  it("批量按张数线性放大", () => {
    const cal = new Calibrator(store);
    const a = cal.estimate(512, 512, 4, 1);
    const b = cal.estimate(512, 512, 4, 3);
    expect(b.seconds).toBeCloseTo((a.seconds - 180) * 3 + 180, 0);
  });
});
