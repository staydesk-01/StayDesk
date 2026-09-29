import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Tests share one MongoDB test database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
