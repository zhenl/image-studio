/**
 * Fastify 应用工厂：注册所有路由与插件。
 * 独立于监听端口，便于测试用 app.inject() 直调。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { generateRoutes } from "./routes/generate.js";
import { modelRoutes } from "./routes/models.js";
import { promptRoutes } from "./routes/prompts.js";
import { buildContext, type AppContext } from "./context.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

export function buildApp(ctx: AppContext = buildContext()): FastifyInstance {
  // bodyLimit：多张参考图 base64 可达数十 MB
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });

  app.get("/", async (_req, reply) => {
    reply.header("Content-Type", MIME[".html"]);
    return reply.send(fs.createReadStream(path.join(config.frontendDirAbs, "index.html")));
  });
  for (const file of ["app.js", "style.css"]) {
    app.get(`/${file}`, (_req, reply) => {
      const full = path.join(config.frontendDirAbs, file);
      reply.header("Content-Type", MIME[path.extname(file)] ?? "text/plain");
      if (fs.existsSync(full)) return reply.send(fs.createReadStream(full));
      // 兜底：执行环境文件层偶发丢文件（见 comic-studio-ts/docs/文件丢失问题排查.md），
      // 直接从 git HEAD 取内容返回，页面不再白屏
      try {
        const blob = execFileSync("git", ["show", `HEAD:frontend/${file}`],
          { cwd: config.projectRoot, maxBuffer: 5 * 1024 * 1024 });
        console.warn(`[兜底] frontend/${file} 磁盘缺失，已用 git HEAD 版本直接提供（${blob.length}B）`);
        return reply.send(blob);
      } catch {
        return reply.status(404).send({ message: `前端文件缺失且 git 无此文件：${file}` });
      }
    });
  }
  app.register(healthRoutes, { prefix: "/api/v1" });
  app.register(
    (instance) => {
      generateRoutes(instance, ctx);
      modelRoutes(instance, ctx);
      promptRoutes(instance, ctx);
    },
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
