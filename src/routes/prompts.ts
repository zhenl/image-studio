/**
 * 提示词库：常用提示词 / 常用反向提示词的增删改查与使用计数。
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { newId, nowIso } from "../util/ids.js";

export function promptRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store } = ctx;

  app.get("/prompts", (req) => {
    const q = req.query as { kind?: string; q?: string };
    return { items: store.listPrompts(q.kind, q.q) };
  });

  app.post("/prompts", (req, reply) => {
    const body = req.body as { kind?: string; text?: string } | null;
    const kind = body?.kind;
    const text = (body?.text ?? "").trim();
    if ((kind !== "prompt" && kind !== "negative") || !text) {
      return reply.status(422).send({
        code: "INVALID",
        message: "kind 须为 prompt|negative 且 text 不能为空",
      });
    }
    const row = {
      id: newId("pmt"), kind: kind as "prompt" | "negative",
      text, use_count: 0, created_at: nowIso(),
    };
    store.insertPrompt(row);
    return row;
  });

  app.put("/prompts/:id", (req, reply) => {
    const id = (req.params as { id: string }).id;
    const text = ((req.body as { text?: string } | null)?.text ?? "").trim();
    if (!store.getPrompt(id)) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "提示词不存在" });
    }
    if (!text) return reply.status(422).send({ code: "INVALID", message: "text 不能为空" });
    store.updatePromptText(id, text);
    return { ok: true };
  });

  app.delete("/prompts/:id", (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!store.getPrompt(id)) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "提示词不存在" });
    }
    store.deletePrompt(id);
    return { ok: true };
  });

  /** 使用（替换/追加到输入框时调用）：计数 + 返回文本。 */
  app.post("/prompts/:id/use", (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.getPrompt(id);
    if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "提示词不存在" });
    store.touchPrompt(id);
    return { ok: true, kind: row.kind, text: row.text };
  });
}
