import { defineConfig } from "vitest/config";

/**
 * The integration suite (src/**\/*.integration.test.ts): routes driven through
 * the real app against a real Postgres, with real Clerk-style token
 * verification against a local key server. Nothing is mocked. Separate from
 * the unit config because it needs DATABASE_URL pointing at a disposable
 * database, and runs files one at a time because they share that database.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/test/integration/global-setup.ts"],
    setupFiles: ["src/test/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
