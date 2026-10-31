/**
 * 串行任务调度器：GPU 任务并行没有意义，逐个消费。
 * worker 可注入（测试用假引擎，毫秒级完成）。
 */
import type { Store } from "../db/store.js";
import type { EventBus } from "../events/bus.js";

export type JobWorker = (jobId: string, params: Record<string, unknown>) => Promise<void>;

export interface SchedulerOptions {
  maxQueueSize: number;
  store: Store;
  bus: EventBus;
  worker: JobWorker;
}

interface QueueItem {
  jobId: string;
  params: Record<string, unknown>;
}

export class Scheduler {
  private queue: QueueItem[] = [];
  private running: string | null = null;
  private readonly maxQueueSize: number;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly worker: JobWorker;
  private canceled = new Set<string>();

  constructor(opts: SchedulerOptions) {
    this.maxQueueSize = opts.maxQueueSize;
    this.store = opts.store;
    this.bus = opts.bus;
    this.worker = opts.worker;
  }

  /** 入队。队满抛错；立即返回排队位置（1 起，含正在执行的任务）。 */
  submit(jobId: string, params: Record<string, unknown>): number {
    if (this.queue.length + (this.running ? 1 : 0) >= this.maxQueueSize) {
      throw new Error("队列已满，请稍后重试");
    }
    this.queue.push({ jobId, params });
    const position = this.queue.length + (this.running ? 1 : 0);
    void this.pump();
    return position;
  }

  queueSize(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  currentJob(): string | null {
    return this.running;
  }

  /** 取消排队中的任务（运行中的任务由 worker 内部响应中断）。 */
  cancel(jobId: string): boolean {
    const idx = this.queue.findIndex((q) => q.jobId === jobId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.store.updateJob(jobId, { status: "canceled", message: "已取消", finished_at: new Date().toISOString() });
      this.bus.publish(jobId, { event: "done", data: { status: "canceled" } });
      return true;
    }
    if (this.running === jobId) {
      this.canceled.add(jobId); // 标记，pump 完成后丢弃结果
      return true;
    }
    return false;
  }

  isCancelRequested(jobId: string): boolean {
    return this.canceled.has(jobId);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = next.jobId;
    this.store.updateJob(next.jobId, {
      status: "running", started_at: new Date().toISOString(), progress: 1, message: "运行中",
    });
    this.bus.publish(next.jobId, { event: "status", data: { status: "running", progress: 1 } });
    try {
      await this.worker(next.jobId, next.params);
    } catch (err) {
      const msg = (err as Error).message;
      this.store.updateJob(next.jobId, {
        status: "failed", error: msg, message: "失败",
        finished_at: new Date().toISOString(),
      });
      this.bus.publish(next.jobId, { event: "error", data: { status: "failed", error: msg } });
    } finally {
      this.canceled.delete(next.jobId);
      this.running = null;
      if (this.queue.length > 0) void this.pump();
    }
  }
}
