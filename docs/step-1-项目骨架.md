# Step 1 · 项目骨架：TypeScript + Fastify + Vitest

本步骤搭建 image-studio 的可测试地基。对应分支 `step-1-scaffold`。

## 完成内容

- **包与工具链**：ESM（`"type": "module"`）+ TypeScript strict 模式 +
  `tsx` 直跑（无编译产物负担）+ `vitest` 测试与覆盖率
- **配置模块**（`src/config.ts`）：zod schema 定义全部配置项，
  环境变量 > `.env` > 默认值三级合并；`loadConfig(env)` 可注入，
  测试不需要读文件、不污染单例
- **应用工厂**（`src/app.ts`）：`buildApp()` 返回未监听的 Fastify 实例，
  测试用 `app.inject()` 直调路由，不占端口
- **启动入口**（`src/server.ts`）：唯一的副作用代码（监听端口），
  从覆盖率统计中排除
- **健康检查**（`GET /api/v1/health`）：返回引擎模式与 ComfyUI 地址

## 关键技术决策

### 为什么用「应用工厂 + 注入」而不是全局单例

全局单例配置会让测试难以隔离
修改全局状态的副作用。TS 版把「构建」与「配置」分离：

```typescript
// 运行时：单例
export const config: AppConfig = loadConfig();
// 测试：显式注入，互不干扰
const c = loadConfig({ PORT: "9001", ENGINE_MODE: "mock" });
```

`buildApp()` 同理——每次返回独立实例，`inject()` 模拟完整 HTTP 请求
响应周期，是 Fastify 生态最大的测试优势之一。

### zod 代替 pydantic-settings

类型与校验一体，且 coerce（`"8030"` → `8030`）显式声明。
非法值在启动即失败（fail fast），对应 Python 版靠 pydantic 报错。

### 覆盖率门槛建在配置里

`vitest.config.ts` 中 `coverage.thresholds` 设为 lines/statements 90%、
branches 85%——`npm run test:coverage` 不达标直接失败，CI 可拦。

## 目录结构

```
src/
  config.ts          # zod 配置
  app.ts             # Fastify 工厂 + ensureDirs
  server.ts          # 监听入口（不计覆盖率）
  routes/health.ts   # 健康检查
  util/ids.ts        # ID/文件名/base64 工具
test/
  config.test.ts / app.test.ts / ids.test.ts
```

## 验证

```bash
npm run test:coverage   # 全部通过，覆盖率 ≥ 90%
npm run typecheck       # tsc --noEmit 无错误
```
