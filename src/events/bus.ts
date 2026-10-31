/**
 * 应用内事件总线：SSE 推送的来源。
 * 生成流程（可能在线程/异步上下文中）publish，SSE 路由 subscribe。
 */
import { EventEmitter } from "node:events";

export interface JobEvent {
  event: "status" | "progress" | "image" | "done" | "error";
  data: unknown;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(jobId: string, ev: JobEvent): void {
    this.emitter.emit(`job:${jobId}`, ev);
  }

  subscribe(jobId: string, cb: (ev: JobEvent) => void): () => void {
    this.emitter.on(`job:${jobId}`, cb);
    return () => this.emitter.off(`job:${jobId}`, cb);
  }
}
