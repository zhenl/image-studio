import { describe, it, expect, vi } from "vitest";
import {
  ComfyClient,
  ComfyError,
  type FetchLike,
  type WsFactory,
  type WsLike,
} from "../src/comfy/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  handler: FetchLike,
  wsFactory?: WsFactory,
): ComfyClient {
  return new ComfyClient({
    baseUrl: "http://127.0.0.1:8188/",
    fetchImpl: handler,
    wsFactory,
    timeoutMs: 1000,
  });
}

describe("ComfyClient 基础", () => {
  it("baseUrl 去尾部斜杠", () => {
    const c = makeClient(async () => jsonResponse({}));
    expect(c.baseUrl).toBe("http://127.0.0.1:8188");
  });

  it("ping 可达返回 true", async () => {
    const c = makeClient(async () => jsonResponse({ devices: [] }));
    expect(await c.ping()).toBe(true);
  });

  it("ping 不可达返回 false（不抛错）", async () => {
    const c = makeClient(async () => { throw new Error("ECONNREFUSED"); });
    expect(await c.ping()).toBe(false);
  });

  it("systemStats 解析设备信息", async () => {
    const c = makeClient(async (url) => {
      expect(url).toContain("/system_stats");
      return jsonResponse({ devices: [{ name: "RTX 5090", vram_total: 1, vram_free: 1 }] });
    });
    const st = await c.systemStats();
    expect(st.devices[0]!.name).toBe("RTX 5090");
  });
});

describe("submit", () => {
  const wf = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };

  it("成功返回 prompt_id", async () => {
    const c = makeClient(async () =>
      jsonResponse({ prompt_id: "p1", number: 1, node_errors: {} }));
    expect(await c.submit(wf, "client-a")).toBe("p1");
  });

  it("node_errors 非空抛 NODE_ERRORS", async () => {
    const c = makeClient(async () =>
      jsonResponse({ prompt_id: "p1", number: 1, node_errors: { "1": "bad" } }));
    await expect(c.submit(wf, "client-a")).rejects.toMatchObject({
      code: "NODE_ERRORS",
    });
  });

  it("HTTP 非 2xx 抛 UNREACHABLE", async () => {
    const c = makeClient(async () => jsonResponse({}, 500));
    await expect(c.submit(wf, "client-a")).rejects.toMatchObject({
      code: "UNREACHABLE",
    });
  });

  it("网络错误包装为 ComfyError", async () => {
    const c = makeClient(async () => { throw new Error("boom"); });
    await expect(c.submit(wf, "client-a")).rejects.toBeInstanceOf(ComfyError);
  });
});

describe("history / viewImage / uploadImage", () => {
  it("history 返回对应条目；不存在返回 null", async () => {
    const c = makeClient(async (url) =>
      jsonResponse(url.includes("/history/p1")
        ? { p1: { status: { status_str: "success", completed: true }, outputs: {} } }
        : {}));
    expect((await c.history("p1"))?.status.completed).toBe(true);
    expect(await c.history("p-none")).toBeNull();
  });

  it("viewImage 返回二进制", async () => {
    const c = makeClient(async (url) => {
      expect(url).toContain("/view?filename=img.png");
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const buf = await c.viewImage({ filename: "img.png", subfolder: "", type: "output" });
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it("viewImage 缺省 subfolder/type 时使用默认值", async () => {
    const c = makeClient(async (url) => {
      expect(url).toContain("subfolder=&type=output");
      return new Response(new Uint8Array([9]));
    });
    // @ts-expect-error 故意缺字段：运行时用 ?? 兜底
    const buf = await c.viewImage({ filename: "img.png" });
    expect(buf.length).toBe(1);
  });

  it("viewImage 失败抛 NO_OUTPUT", async () => {
    const c = makeClient(async () => jsonResponse({}, 404));
    await expect(c.viewImage({ filename: "x", subfolder: "", type: "output" }))
      .rejects.toMatchObject({ code: "NO_OUTPUT" });
  });

  it("uploadImage 返回服务端文件名", async () => {
    const c = makeClient(async (url, init) => {
      expect(url).toContain("/upload/image");
      expect(init?.method).toBe("POST");
      return jsonResponse({ name: "uploaded.png", subfolder: "", type: "input" });
    });
    expect(await c.uploadImage(Buffer.from("x"), "a.png")).toBe("uploaded.png");
  });

  it("uploadImage 失败抛错", async () => {
    const c = makeClient(async () => jsonResponse({}, 500));
    await expect(c.uploadImage(Buffer.from("x"), "a.png")).rejects.toBeInstanceOf(ComfyError);
  });
});

describe("listen（假 WebSocket）", () => {
  function fakeWs(events: unknown[], closeAfter = false): WsFactory & { sockets: unknown[] } {
    class FakeWs implements WsLike {
      handlers = new Map<string, Array<(...args: unknown[]) => void>>();
      closed = false;
      on(event: string, cb: (...args: unknown[]) => void): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      }
      close(): void { this.closed = true; }
      async run(): Promise<void> {
        await new Promise((r) => setTimeout(r, 5));
        for (const ev of events) {
          if (this.closed) return;
          for (const cb of this.handlers.get("message") ?? []) cb(ev);
        }
        if (closeAfter && !this.closed) {
          for (const cb of this.handlers.get("close") ?? []) cb(1000);
        }
      }
    }
    const sockets: unknown[] = [];
    const factory: WsFactory = {
      connect(url: string): WsLike {
        expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:8188\/ws\?clientId=/);
        const s = new FakeWs();
        sockets.push(s);
        void s.run();
        return s;
      },
    };
    return Object.assign(factory, { sockets });
  }

  it("execution_success → ok=true，事件全部转发", async () => {
    const factory = fakeWs([
      { type: "execution_start", data: { prompt_id: "p1" } },
      { type: "progress", data: { value: 5, max: 20 } },
      { type: "execution_success", data: {} },
    ]);
    const c = makeClient(async () => jsonResponse({}), factory);
    const seen: string[] = [];
    const r = await c.listen("client-a", "p1", (ev) => seen.push(ev.type), 2000);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["execution_start", "progress", "execution_success"]);
  });

  it("execution_error → ok=false 带错误信息", async () => {
    const factory = fakeWs([
      { type: "execution_error", data: { exception_message: "tensor mismatch" } },
    ]);
    const c = makeClient(async () => jsonResponse({}), factory);
    const r = await c.listen("client-a", "p1", () => {}, 2000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("tensor");
  });

  it("超时 → ok=false 提示超时", async () => {
    const factory = fakeWs([]); // 无事件
    const c = makeClient(async () => jsonResponse({}), factory);
    const r = await c.listen("client-a", "p1", () => {}, 50);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
  });

  it("连接中断时用 history 兜底：completed → ok=true", async () => {
    const factory = fakeWs([], true); // 直接 close
    const c = makeClient(async (url) =>
      url.includes("/history/")
        ? jsonResponse({ p1: { status: { status_str: "success", completed: true }, outputs: {} } })
        : jsonResponse({}), factory);
    const r = await c.listen("client-a", "p1", () => {}, 2000);
    expect(r.ok).toBe(true);
  });

  it("二进制帧被忽略、字符串帧被解析、error 事件终止监听", async () => {
    // 用自定义 fakeWs 逐个注入三种形态
    class RawWs {
      handlers = new Map<string, Array<(...a: unknown[]) => void>>();
      closed = false;
      on(event: string, cb: (...a: unknown[]) => void): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      }
      close(): void { this.closed = true; }
    }
    const ws = new RawWs();
    const factory: WsFactory = { connect: () => ws as unknown as WsLike };
    const c = makeClient(async () => jsonResponse({}), factory);
    const p = c.listen("client-a", "p1", () => {}, 2000);
    await new Promise((r) => setTimeout(r, 5));
    for (const cb of ws.handlers.get("message") ?? []) cb(Buffer.from([1, 2])); // 二进制 → 忽略
    for (const cb of ws.handlers.get("message") ?? []) cb(JSON.stringify({ type: "progress", data: { value: 1, max: 2 } })); // 字符串
    for (const cb of ws.handlers.get("error") ?? []) cb(new Error("ws boom")); // error 终止
    const r = await p;
    expect(r).toEqual({ ok: false, error: "ws boom" });
  });

  it("无 wsFactory 时 reject", async () => {
    const c = makeClient(async () => jsonResponse({}));
    await expect(c.listen("c", "p", () => {}, 100)).rejects.toBeInstanceOf(ComfyError);
  });
});

describe("listNodeFiles", () => {
  it("合并多个节点的文件列表并去重（非字符串项被过滤）", async () => {
    const c = makeClient(async (url) => {
      if (url.includes("UnetLoaderGGUF")) {
        return jsonResponse({ UnetLoaderGGUF: { input: { required: { unet_name: [["a.gguf", 42]] } } } });
      }
      return jsonResponse({ UNETLoader: { input: { required: { unet_name: [["a.gguf", "b.safetensors"]] } } } });
    });
    expect(await c.listNodeFiles(["UnetLoaderGGUF", "UNETLoader"], "unet_name"))
      .toEqual(["a.gguf", "b.safetensors"]);
  });

  it("ComfyUI 不可达返回 null（调用方回退）", async () => {
    const c = makeClient(async () => { throw new Error("down"); });
    expect(await c.listNodeFiles(["CLIPLoader"], "clip_name")).toBeNull();
  });

  it("空列表返回 null", async () => {
    const c = makeClient(async () =>
      jsonResponse({ X: { input: { required: { f: [[]] } } } }));
    expect(await c.listNodeFiles(["X"], "f")).toBeNull();
  });
});
