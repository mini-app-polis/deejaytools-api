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
      // A floor, not a target: `pnpm test:coverage` fails if coverage drops
      // below where it already is. When a change raises it, running the same
      // command locally rewrites these numbers (rounded down) — commit them,
      // and the floor has moved up for good. Coverage is otherwise enforced by
      // what is tested, not by a number: see the route ledger in
      // src/test/integration/route-ledger.ts.
      thresholds: {
        statements: 81,
        branches: 71,
        functions: 73,
        lines: 83,
        autoUpdate: (next: number) => Math.floor(next),
      },
    },
  },
});
