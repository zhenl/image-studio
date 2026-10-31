/**
 * Fastify 应用工厂：注册所有路由与插件。
 * 独立于监听端口，便于测试用 app.inject() 直调。
 */
import fs from "node:fs";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/", async () => ({ name: "image-studio", status: "ok" }));
  app.register(healthRoutes, { prefix: "/api/v1" });

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
