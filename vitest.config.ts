import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts"],
    // The integration suite needs a real database; it has its own config.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
    },
  },
});
