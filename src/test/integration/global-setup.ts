import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import type { TestProject } from "vitest/node";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { startClerk, stopClerk } from "./clerk.js";
import { integrationDatabaseUrl } from "./database-url.js";
import { ledgerProblems, useLedgerDir } from "./route-ledger.js";
import { integrationBaseUrl, jwksPort } from "./target.js";

declare module "vitest" {
  export interface ProvidedContext {
    routeLedgerDir: string;
    clerkJwksUrl: string;
  }
}

/**
 * Builds the schema the way production does: from an empty database, by
 * applying every migration in ./drizzle. A migration that fails on real
 * Postgres fails the suite here, before any test runs.
 *
 * Starts the stand-in Clerk key server for the whole run (clerk.ts), and,
 * when the suite targets a separately started API (INTEGRATION_BASE_URL),
 * checks that it answers before any test runs.
 *
 * Once every test has run, checks the route ledger (route-ledger.ts): each
 * route the app registers was called by some test, or is listed as not
 * exercised with a reason.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
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

  const jwksUrl = await startClerk(jwksPort());
  project.provide("clerkJwksUrl", jwksUrl);

  const target = integrationBaseUrl();
  if (target) {
    await checkTarget(target, jwksUrl);
  }

  return async () => {
    await stopClerk();
    const problems = ledgerProblems();
    rmSync(dir, { recursive: true, force: true });
    if (problems.length) {
      throw new Error(`Route ledger:\n  ${problems.join("\n  ")}`);
    }
  };
}

/** Fail fast, with the setup it needs, when the target API is not there. */
async function checkTarget(target: string, jwksUrl: string): Promise<void> {
  let status: number | string;
  try {
    status = (await fetch(`${target}/health`, { signal: AbortSignal.timeout(5_000) })).status;
  } catch (err) {
    status = err instanceof Error ? err.message : String(err);
  }
  if (status !== 200) {
    await stopClerk();
    throw new Error(
      `INTEGRATION_BASE_URL=${target}: GET /health did not return 200 (${status}). ` +
        "Start the API first, pointed at the same _test database, with " +
        `DEEJAYTOOLS_CLERK_JWKS_URL=${jwksUrl}, the test issuer and DISABLE_SCHEDULER=1. ` +
        "See docs/CONFORMANCE.md."
    );
  }
  console.info(`[integration] driving ${target} over HTTP; JWKS at ${jwksUrl}`);
}
