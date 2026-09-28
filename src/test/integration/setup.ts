import { afterAll, beforeEach, inject, vi } from "vitest";
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
// Feedback emails through Brevo only when a key is set; never from tests.
delete process.env.BREVO_API_KEY;

// CI has no Google Drive. The upload and share calls are wrapped so a test
// can stand in for them (see songs-upload.integration.test.ts); by default
// they run the real code, which fails fast with Drive unconfigured. The mock
// lives here because this file loads the app before any test file runs.
vi.mock("../../services/drive.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../services/drive.js")>();
  return {
    ...real,
    uploadSongToDrive: vi.fn(real.uploadSongToDrive),
    shareDriveFileWithUsers: vi.fn(real.shareDriveFileWithUsers),
  };
});

const { app, resetDatabase } = await import("./harness.js");
const { recordRoutes, useLedgerDir } = await import("./route-ledger.js");
useLedgerDir(inject("routeLedgerDir"));

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  recordRoutes(app.routes);
  await stopClerk();
});
