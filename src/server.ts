/**
 * 启动入口（不参与覆盖率统计）。
 */
import { buildApp, ensureDirs } from "./app.js";
import { config } from "./config.js";

ensureDirs();
const app = buildApp();

app.listen({ host: config.HOST, port: config.PORT }, (err) => {
  if (err) {
    console.error("[启动失败]", err);
    process.exit(1);
  }
  console.log(`[启动] image-studio → http://${config.HOST}:${config.PORT}`);
  console.log(`[启动] 引擎: ${config.ENGINE_MODE} (${config.COMFYUI_URL})`);
});
