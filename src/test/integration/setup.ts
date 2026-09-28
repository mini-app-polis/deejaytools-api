import { afterAll, beforeEach } from "vitest";
import { integrationDatabaseUrl } from "./database-url.js";
import { startClerk, stopClerk, TEST_ISSUER } from "./clerk.js";

// Environment the app reads at import time, set before any test file imports
// it. Guarded first: never let a test file open a connection to a database
// the suite is not allowed to truncate.
integrationDatabaseUrl();
process.env.NODE_ENV = "test";
process.env.CLERK_ISSUER = TEST_ISSUER;
process.env.CLERK_JWKS_URL = await startClerk();
delete process.env.TICK_SECRET;

const { resetDatabase } = await import("./harness.js");

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await stopClerk();
});
