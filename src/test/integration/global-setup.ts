import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { integrationDatabaseUrl } from "./database-url.js";

/**
 * Builds the schema the way production does: from an empty database, by
 * applying every migration in ./drizzle. A migration that fails on real
 * Postgres fails the suite here, before any test runs.
 */
export default async function setup(): Promise<void> {
  const client = postgres(integrationDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await client.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }
}
