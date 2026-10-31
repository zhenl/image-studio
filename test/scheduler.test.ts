import { describe, it, expect, vi } from "vitest";
import { Scheduler } from "../src/queue/scheduler.js";
import { Store } from "../src/db/store.js";
import { EventBus } from "../src/events/bus.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeScheduler(maxQueue = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "is-q-"));
  const store = new Store(path.join(dir, "app.db"));
  const bus = new EventBus();
  const worker = vi.fn<(id: string, p: Record<string, unknown>) => Promise<void>>(
    async () => { await new Promise((r) => setTimeout(r, 10)); },
  );
  const sched = new Scheduler({ maxQueueSize: maxQueue, store, bus, worker });
  return { sched, store, bus, worker, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function mkJob(store: Store, id: string): void {
  store.createJob({
    id, mode: "txt2img", prompt: "p", negative: "", params_json: "{}",
    seed: -1, count: 1, created_at: new Date().toISOString(),
  });
}

describe("Scheduler 正式用例", () => {
  it("串行执行两个任务", async () => {
    const ctx = makeScheduler();
    mkJob(ctx.store, "j1");
    mkJob(ctx.store, "j2");
    expect(ctx.sched.submit("j1", {})).toBe(1);
    expect(ctx.sched.submit("j2", {})).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => {
      expect(ctx.worker).toHaveBeenCalledTimes(2);
    });
    expect(ctx.store.getJob("j1")!.status).toBe("running");
    expect(ctx.sched.queueSize()).toBe(0);
    ctx.cleanup();
  });

  it("队满抛错", () => {
    const ctx = makeScheduler(1);
    mkJob(ctx.store, "j1");
    ctx.sched.submit("j1", {});
    expect(() => ctx.sched.submit("j2", {})).toThrow("队列已满");
    ctx.cleanup();
  });

  it("worker 抛错 → 任务标记 failed 并发布 error 事件", async () => {
    const ctx = makeScheduler();
    ctx.worker.mockImplementation(async () => { throw new Error("引擎崩溃"); });
    mkJob(ctx.store, "j1");
    const events: string[] = [];
    ctx.bus.subscribe("j1", (ev) => events.push(ev.event));
    ctx.sched.submit("j1", {});
    await vi.waitFor(() => {
      expect(ctx.store.getJob("j1")!.status).toBe("failed");
    });
    expect(ctx.store.getJob("j1")!.error).toContain("引擎崩溃");
    expect(events).toContain("error");
    ctx.cleanup();
  });

  it("取消排队中的任务：出队、标记 canceled、发布 done", async () => {
    const ctx = makeScheduler();
    ctx.worker.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    mkJob(ctx.store, "j1");
    mkJob(ctx.store, "j2");
    const events: string[] = [];
    ctx.bus.subscribe("j2", (ev) => events.push(ev.event));
    ctx.sched.submit("j1", {});
    ctx.sched.submit("j2", {});
    expect(ctx.sched.cancel("j2")).toBe(true);
    await vi.waitFor(() => expect(ctx.worker).toHaveBeenCalledTimes(1));
    expect(ctx.store.getJob("j2")!.status).toBe("canceled");
    expect(events).toContain("done");
    ctx.cleanup();
  });

  it("取消运行中的任务：标记取消请求", async () => {
    const ctx = makeScheduler();
    ctx.worker.mockImplementation(async (id) => {
      await vi.waitFor(() => expect(ctx.sched.isCancelRequested(id)).toBe(true), { timeout: 2000 });
    });
    mkJob(ctx.store, "j1");
    ctx.sched.submit("j1", {});
    await vi.waitFor(() => expect(ctx.sched.currentJob()).toBe("j1"));
    expect(ctx.sched.cancel("j1")).toBe(true);
    await vi.waitFor(() => expect(ctx.sched.currentJob()).toBeNull());
    expect(ctx.sched.isCancelRequested("j1")).toBe(false); // finally 清理
    ctx.cleanup();
  });

  it("取消不存在的任务返回 false", () => {
    const ctx = makeScheduler();
    expect(ctx.sched.cancel("nope")).toBe(false);
    ctx.cleanup();
  });
});

describe("EventBus", () => {
  it("publish/subscribe 与退订", () => {
    const bus = new EventBus();
    const got: string[] = [];
    const off = bus.subscribe("j1", (ev) => got.push(ev.event));
    bus.publish("j1", { event: "progress", data: {} });
    off();
    bus.publish("j1", { event: "done", data: {} });
    expect(got).toEqual(["progress"]);
  });
});
