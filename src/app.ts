/**
 * Fastify 应用工厂：注册所有路由与插件。
 * 独立于监听端口，便于测试用 app.inject() 直调。
 */
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { generateRoutes } from "./routes/generate.js";
import { buildContext, type AppContext } from "./context.js";

export function buildApp(ctx: AppContext = buildContext()): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/", async () => ({ name: "image-studio", status: "ok" }));
  app.register(healthRoutes, { prefix: "/api/v1" });
  app.register(
    (instance) => void generateRoutes(instance, ctx),
    { prefix: "/api/v1" },
  );

  // 产物静态服务：/data/** → <DATA_DIR>/**
  app.get("/data/*", (req, reply) => {
    const rel = (req.params as { "*": string })["*"];
    const root = path.resolve(ctx.cfg.dataDirAbs);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root)) return reply.status(403).send({ message: "禁止访问" });
    if (!fs.existsSync(file)) return reply.status(404).send({ message: "不存在" });
    return reply.header("Content-Type", "image/png").send(fs.createReadStream(file));
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({
      error: err.name,
      message: err.message,
    });
  });
  return app;
}

export function ensureDirs(): void {
  for (const dir of [config.dataDirAbs, config.outputDirAbs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
