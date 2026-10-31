import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/types/generated/**"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
