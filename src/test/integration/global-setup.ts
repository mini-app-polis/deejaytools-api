import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import type { TestProject } from "vitest/node";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { integrationDatabaseUrl } from "./database-url.js";
import { ledgerProblems, useLedgerDir } from "./route-ledger.js";

declare module "vitest" {
  export interface ProvidedContext {
    routeLedgerDir: string;
  }
}

/**
 * Builds the schema the way production does: from an empty database, by
 * applying every migration in ./drizzle. A migration that fails on real
 * Postgres fails the suite here, before any test runs.
 *
 * Once every test has run, checks the route ledger (route-ledger.ts): each
 * route the app registers was called by some test, or is listed as not
 * exercised with a reason.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "route-ledger-"));
  useLedgerDir(dir);
  project.provide("routeLedgerDir", dir);

  const client = postgres(integrationDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await client.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }

  return () => {
    const problems = ledgerProblems();
    rmSync(dir, { recursive: true, force: true });
    if (problems.length) {
      throw new Error(`Route ledger:\n  ${problems.join("\n  ")}`);
    }
  };
}
