/**
 * ComfyUI HTTP/WS 客户端。
 *
 * 设计要点（可测试性）：
 * - baseUrl 可注入；fetch 与 WebSocket 工厂可注入（测试用假实现，
 *   不依赖真实 ComfyUI，也不占端口）
 * - 所有方法返回结构化结果或抛带信息的 Error，不做静默降级
 */

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

/** API 格式工作流：节点 id → 节点定义 */
export type Workflow = Record<string, WorkflowNode>;

export interface PromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export interface OutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

export interface HistoryEntry {
  status: { status_str: string; completed: boolean };
  outputs: Record<string, { images?: OutputImage[] }>;
}

export type WsEvent =
  | { type: "status"; data: unknown }
  | { type: "execution_start"; data: { prompt_id: string } }
  | { type: "progress"; data: { value: number; max: number } }
  | { type: "executing"; data: { node: string | null } }
  | { type: "executed"; data: { node: string; output: { images?: OutputImage[] } } }
  | { type: "execution_error"; data: { exception_message: string; node_type?: string } }
  | { type: "execution_success"; data: unknown }
  | { type: string; data: unknown };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export interface WsFactory {
  connect(url: string): WsLike;
}

export interface WsLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  close(code?: number, reason?: string): void;
}

export interface ComfyClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike | undefined;
  wsFactory?: WsFactory | undefined;
  timeoutMs?: number;
}

/** 默认 WS 工厂：ws 库适配（生产环境；测试注入假实现）。 */
export function defaultWsFactory(): WsFactory {
  return {
    connect(url: string): WsLike {
      // 动态加载避免 vitest 环境强依赖真实网络栈
      const WS = (require("ws") as typeof import("ws")).default ?? require("ws");
      const sock = new WS(url);
      return {
        on(event, cb) {
          sock.on(event, (...args: unknown[]) => cb(...args));
        },
        close(code?: number, reason?: string) {
          sock.close(code, reason);
        },
      };
    },
  };
}

export class ComfyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "UNREACHABLE" | "NODE_ERRORS" | "TIMEOUT" | "EXECUTION_ERROR" | "NO_OUTPUT",
  ) {
    super(message);
    this.name = "ComfyError";
  }
}

export class ComfyClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly wsFactory: WsFactory | undefined;
  private readonly timeoutMs: number;

  constructor(opts: ComfyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.wsFactory = opts.wsFactory ?? defaultWsFactory();
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res;
    } catch (err) {
      throw new ComfyError(
        `ComfyUI 不可达（${this.baseUrl}${path}）：${(err as Error).message}`,
        "UNREACHABLE",
      );
    }
  }

  /** 连接健康检查。 */
  async ping(): Promise<boolean> {
    try {
      const res = await this.req("/system_stats", { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 设备信息（GPU 名称、显存）。 */
  async systemStats(): Promise<{
    devices: Array<{ name: string; vram_total: number; vram_free: number }>;
  }> {
    const res = await this.req("/system_stats");
    if (!res.ok) throw new ComfyError(`/system_stats ${res.status}`, "UNREACHABLE");
    return (await res.json()) as never;
  }

  /** 提交工作流，返回 prompt_id。node_errors 非空时抛错（任务不会入队）。 */
  async submit(workflow: Workflow, clientId: string): Promise<string> {
    const res = await this.req("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, prompt: workflow }),
    });
    if (!res.ok) {
      throw new ComfyError(`提交失败：HTTP ${res.status}`, "UNREACHABLE");
    }
    const data = (await res.json()) as PromptResponse;
    if (Object.keys(data.node_errors ?? {}).length > 0) {
      throw new ComfyError(
        `工作流节点错误：${JSON.stringify(data.node_errors)}`,
        "NODE_ERRORS",
      );
    }
    return data.prompt_id;
  }

  /** 查询任务历史（WS 偶发丢帧时的兜底）。 */
  async history(promptId: string): Promise<HistoryEntry | null> {
    const res = await this.req(`/history/${promptId}`);
    if (!res.ok) return null;
    const all = (await res.json()) as Record<string, HistoryEntry>;
    return all[promptId] ?? null;
  }

  /** 取图：返回二进制 Buffer。 */
  async viewImage(img: OutputImage): Promise<Buffer> {
    const q = new URLSearchParams({
      filename: img.filename,
      subfolder: img.subfolder ?? "",
      type: img.type ?? "output",
    });
    const res = await this.req(`/view?${q}`);
    if (!res.ok) throw new ComfyError(`/view ${res.status}`, "NO_OUTPUT");
    return Buffer.from(await res.arrayBuffer());
  }

  /** 上传参考图（multipart），返回 ComfyUI 侧文件名。 */
  async uploadImage(buf: Buffer, filename: string, mime = "image/png"): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(buf)], { type: mime }), filename);
    const res = await this.req("/upload/image", { method: "POST", body: form });
    if (!res.ok) throw new ComfyError(`上传失败：HTTP ${res.status}`, "UNREACHABLE");
    const data = (await res.json()) as { name: string };
    return data.name;
  }

  /**
   * 监听 WS 事件直到任务完成（success / error / 超时）。
   * onEvent 收到全部事件；返回最终状态。
   */
  async listen(
    clientId: string,
    promptId: string,
    onEvent: (ev: WsEvent) => void,
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.wsFactory) {
      throw new ComfyError("未提供 WebSocket 工厂", "UNREACHABLE");
    }
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;
    const socket = this.wsFactory.connect(wsUrl);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: { ok: boolean; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        try { socket.close(); } catch { /* 已关闭 */ }
        resolve(result);
      };
      const finish = settle;

      const timer = setTimeout(() => {
        settle({ ok: false, error: `推理超时（>${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);

      // history 兜底轮询：WS 订阅建立晚于任务完成（快速任务）或丢帧时，
      // 通过 /history 的 completed 标志收敛，避免永久等待
      const poll = setInterval(() => {
        void this.history(promptId).then((h) => {
          if (h?.status.completed) settle({ ok: true });
          else if (h && h.status.status_str === "error") {
            settle({ ok: false, error: "执行失败（详见 ComfyUI 日志）" });
          }
        }).catch(() => { /* 轮询失败忽略，等下一轮 */ });
      }, 3000);
      void poll.unref?.();

      socket.on("message", (raw: unknown) => {
        if (Buffer.isBuffer(raw)) return; // 预览图二进制帧，忽略
        const ev = (typeof raw === "string" ? JSON.parse(raw) : raw) as WsEvent;
        onEvent(ev);
        if (ev.type === "execution_success") finish({ ok: true });
        else if (ev.type === "execution_error") {
          const d = ev.data as { exception_message: string };
          finish({ ok: false, error: d.exception_message });
        }
      });
      socket.on("error", (err: unknown) =>
        finish({ ok: false, error: (err as Error).message }));
      socket.on("close", () => {
        // 非正常完成时通过 history 兜底校验
        void this.history(promptId).then((h) => {
          if (h?.status.completed) settle({ ok: true });
          else settle({ ok: false, error: "WebSocket 连接中断" });
        });
      });
    });
  }

  /** 查询某类加载器节点可见的模型文件列表（模型管理的权威数据源）。 */
  async listNodeFiles(
    nodeNames: string[],
    field: string,
  ): Promise<string[] | null> {
    const seen: string[] = [];
    for (const node of nodeNames) {
      try {
        const res = await this.req(`/object_info/${node}`);
        if (!res.ok) return null;
        const info = (await res.json()) as Record<string, never>;
        const def = info[node] as unknown as {
          input: { required: Record<string, [string[]]> };
        };
        const values = def.input.required[field]?.[0] ?? [];
        seen.push(...values.filter((v): v is string => typeof v === "string"));
      } catch {
        return null;
      }
    }
    return seen.length ? [...new Set(seen)] : null;
  }
}
