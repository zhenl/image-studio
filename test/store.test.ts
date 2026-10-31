import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "is-db-"));
  store = new Store(path.join(dir, "app.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function job(over: Partial<Parameters<Store["createJob"]>[0]> = {}) {
  return {
    id: "job_1", mode: "txt2img", prompt: "a cat", negative: "",
    params_json: "{}", seed: -1, count: 1, created_at: new Date().toISOString(),
    ...over,
  };
}

function image(over: Record<string, unknown> = {}) {
  return {
    id: "img_1", job_id: "job_1", path: "data/outputs/x.png", url: "/data/outputs/x.png",
    width: 768, height: 768, steps: 8, guidance: 4, seed: 1,
    prompt: "a cat", negative: "", mode: "txt2img", ref_mode: "",
    favorite: 0, flagged: 0, elapsed_ms: 12000, created_at: new Date().toISOString(),
    ...over,
  } as never;
}

describe("Store jobs", () => {
  it("创建并查询任务", () => {
    store.createJob(job());
    const row = store.getJob("job_1")!;
    expect(row.status).toBe("queued");
    expect(row.progress).toBe(0);
    expect(row.message).toBe("排队中");
  });

  it("updateJob 更新状态与进度", () => {
    store.createJob(job());
    store.updateJob("job_1", { status: "running", progress: 50, message: "采样中" });
    const row = store.getJob("job_1")!;
    expect(row.status).toBe("running");
    expect(row.progress).toBe(50);
  });

  it("updateJob 空字段不产生 SQL", () => {
    store.createJob(job());
    expect(() => store.updateJob("job_1", {})).not.toThrow();
  });

  it("listJobs 按状态过滤与限量", () => {
    store.createJob(job({ id: "a", created_at: "2026-01-01T00:00:00Z" }));
    store.createJob(job({ id: "b", created_at: "2026-01-02T00:00:00Z" }));
    store.createJob(job({ id: "c", created_at: "2026-01-03T00:00:00Z" }));
    expect(store.listJobs(2).map((r) => r.id)).toEqual(["c", "b"]);
    store.updateJob("c", { status: "succeeded" });
    expect(store.listJobs(10, "succeeded").map((r) => r.id)).toEqual(["c"]);
  });

  it("deleteJob 删除任务", () => {
    store.createJob(job());
    store.deleteJob("job_1");
    expect(store.getJob("job_1")).toBeUndefined();
  });
});

describe("Store images", () => {
  it("插入与按任务查询", () => {
    store.createJob(job());
    store.insertImage(image());
    const imgs = store.imagesByJob("job_1");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.url).toContain("x.png");
  });

  it("listImages 收藏过滤与限量", () => {
    store.createJob(job());
    store.insertImage(image({ id: "a", created_at: "2026-01-01T00:00:00Z" }));
    store.insertImage(image({ id: "b", created_at: "2026-01-02T00:00:00Z" }));
    store.setFavorite("a", true);
    expect(store.listImages(10, true).map((i) => i.id)).toEqual(["a"]);
    expect(store.listImages(1).map((i) => i.id)).toEqual(["b"]);
  });

  it("recentImagesForCalibration 过滤无效记录", () => {
    store.createJob(job());
    store.insertImage(image({ elapsed_ms: 0, id: "bad" }));
    store.insertImage(image({ id: "good" }));
    const rows = store.recentImagesForCalibration();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.steps).toBe(8);
  });
});
