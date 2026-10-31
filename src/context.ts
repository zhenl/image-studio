/**
 * 应用上下文：装配 Store / Bus / Scheduler / GenerationService / 引擎。
 * buildContext() 可注入覆盖（测试用临时目录与假引擎）。
 */
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { Store } from "./db/store.js";
import { EventBus } from "./events/bus.js";
import { Scheduler } from "./queue/scheduler.js";
import { ComfyClient } from "./comfy/client.js";
import { createDescribeService, type DescribeEngineLike } from "./services/describe.js";
import { GenerationService, type EngineLike } from "./services/generation.js";
import { Calibrator } from "./services/calibration.js";

export interface AppContext {
  cfg: AppConfig;
  store: Store;
  bus: EventBus;
  scheduler: Scheduler;
  engine: EngineLike;
  comfy: ComfyClient;
  generation: GenerationService;
  calibrator: Calibrator;
  describe: ReturnType<typeof createDescribeService>;
  clientId: string;
}

export interface ContextOverrides {
  env?: Record<string, string | undefined>;
  engine?: EngineLike;
  comfy?: ComfyClient;
}

export function buildContext(over: ContextOverrides = {}): AppContext {
  const cfg = over.env
    ? loadConfig(over.env)
    : (globalThis as { __isCtx?: AppContext }).__isCtx?.cfg ?? loadConfig();
  const store = new Store(cfg.dbPathAbs);
  const bus = new EventBus();
  const comfy = over.comfy ?? new ComfyClient({ baseUrl: cfg.COMFYUI_URL });
  const engine = over.engine ?? comfy;
  const clientId = `imagestudio-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  let scheduler: Scheduler;
  const generation: GenerationService = new GenerationService(
    engine, store, bus, cfg,
    (jobId) => scheduler.isCancelRequested(jobId),
  );
  scheduler = new Scheduler({
    maxQueueSize: cfg.MAX_QUEUE_SIZE,
    store, bus,
    worker: (jobId, params) => generation.runJob(jobId, params as never),
  });
  const calibrator = new Calibrator(store);
  const describe = createDescribeService(
    comfy as unknown as DescribeEngineLike, cfg.TEXT_ENCODER_FILE);

  const ctx: AppContext = { cfg, store, bus, scheduler, engine, comfy, generation, calibrator, describe, clientId };
  (globalThis as { __isCtx?: AppContext }).__isCtx = ctx;
  return ctx;
}

/** 静态产物目录挂载前缀（/data → projectRoot/data）。 */
export function dataRoot(cfg: AppConfig): string {
  return path.join(cfg.projectRoot, cfg.DATA_DIR);
}
