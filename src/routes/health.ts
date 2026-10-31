import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

export function healthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({
    ok: true,
    engine_mode: config.ENGINE_MODE,
    comfyui_url: config.COMFYUI_URL,
  }));
}
