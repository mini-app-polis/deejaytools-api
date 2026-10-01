/**
 * Sentry instrumentation bootstrap — must be the first module loaded.
 *
 * Loaded via `node --import ./dist/instrument.js` so that the OpenTelemetry
 * layer Sentry v8+ uses is registered before any other module (including the
 * DB pool, Hono, etc.).  When Sentry.init() runs after other modules have
 * already been imported, the OTel instrumentation is never set up and
 * captureException events may be silently dropped.
 *
 * See: https://docs.sentry.io/platforms/javascript/guides/node/install/esm/
 */
import * as Sentry from "@sentry/node";

// SENTRY_DSN_DEEJAYTOOLS_API is the name in the shared ecosystem Doppler
// config, where SENTRY_DSN belongs to the cogs. SENTRY_DSN is the legacy
// name, read until it is removed there.
const dsn = process.env.SENTRY_DSN_DEEJAYTOOLS_API || process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  environment: process.env.NODE_ENV ?? "development",
  enabled: !!dsn,
  release:
    process.env.RAILWAY_DEPLOYMENT_ID ??
    process.env.npm_package_version,
});
