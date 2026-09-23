# Deployment

How the deejaytools API is built, released, and run in production on **Railway**. The web app lives in [`deejaytools-com`](https://github.com/mini-app-polis/deejaytools-com/blob/main/docs/DEPLOYMENT.md) and deploys separately to Cloudflare Pages.

---

## Topology

| Surface | Host | What deploys it |
|---------|------|-----------------|
| **API** (this repo) | Railway | Railway's GitHub integration watches this repo and builds/deploys the service |
| **Web app** ([`deejaytools-com`](https://github.com/mini-app-polis/deejaytools-com/blob/main/)) | Cloudflare Pages | Cloudflare's GitHub integration watches that repo |

**GitHub Actions does not deploy anything.** `ci.yml` runs verify (typecheck, lint, tests, build) and semantic-release on `main`. It never pushes to Railway and never runs database migrations against production.

---

## Railway

Configuration lives at the repo root in `railway.json` — the location CD-017 checks (restart policy, start command and limits are version-controlled, not dashboard-owned).

### `railway.json` (full file)

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "pnpm build"
  },
  "deploy": {
    "startCommand": "pnpm db:migrate && pnpm start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10,
    "limitOverride": {
      "containers": {
        "cpu": 4,
        "memoryBytes": 4294967296
      }
    }
  }
}
```

Notes the JSON can't carry as comments:

- **Migrations before start (ADR-001)** — `startCommand` runs `db:migrate` before `start`; see below.
- **Limits (CD-024)** — `limitOverride` values are placeholder ceilings, well above what this service uses, so the bound exists without risking an OOM kill on an unmeasured workload. Bring them down to real usage plus headroom once Railway's metrics have been read.
- **Build tooling in `dependencies`** — see "Packaging quirk" below.

### Key-by-key

| Key | Meaning |
|-----|---------|
| `build.builder = "NIXPACKS"` | Railway auto-detects Node/pnpm and runs the build in a Nixpacks container. |
| `build.buildCommand` | `tsc -p tsconfig.build.json` (the `build` script). Does **not** run migrations. |
| `deploy.startCommand` | **Two steps chained with `&&`:** (1) apply pending Drizzle migrations, (2) start the Node server. See below. |
| `deploy.healthcheckPath` | Railway polls `GET /health` after start. |
| `deploy.healthcheckTimeout` | Seconds to wait for a healthy response before marking the deploy failed (30 s). |
| `deploy.restartPolicyType` | Restart the container if the process exits non-zero. |
| `deploy.restartPolicyMaxRetries` | Cap on automatic restarts. |

There is **no Railway cron** defined in this file. Session ticks are driven by an **in-process scheduler** in the API container (see `TICK_INTERVAL_MS` below). `GET /internal/tick` is a manual override, not a scheduled job.

### Migrations before start (ADR-001)

`startCommand` runs `pnpm db:migrate && pnpm start`.

**Why:** Production `DATABASE_URL` lives on Railway, not in CI. Running migrations from the deploy container keeps credentials off the GitHub Actions runner and applies schema changes in the same network/runtime as the service that needs them. Documented in [`docs/decisions/ADR-001-drizzle-migrations-at-deploy.md`](decisions/ADR-001-drizzle-migrations-at-deploy.md).

**Consequence:** If `db:migrate` fails, the `&&` chain stops and **`start` never runs**. Railway marks the deploy failed and **the previous healthy image keeps serving traffic**. You fix the migration (or roll back the commit) and redeploy — you do not get a half-started API on a broken schema.

CI deliberately does **not** run `db:migrate` against production.

### Packaging quirk: `typescript` and `drizzle-kit` in `dependencies`

In `package.json`, `typescript`, `drizzle-kit`, and `@types/node` are listed under **`dependencies`**, not `devDependencies`.

**Why:** Railway sets `NODE_ENV=production`. Under pnpm, that **skips `devDependencies`**. The build step needs `tsc`; the start hook needs `drizzle-kit migrate`. If you “tidy” them into `devDependencies`, the Railway build or migrate step will fail with “command not found” or missing compiler errors.

`tsx`, `vitest`, and test-only tools correctly remain in `devDependencies` — they never run on Railway.

### Start command and Sentry bootstrap

From `package.json`:

```json
"start": "node --import ./dist/instrument.js dist/index.js"
```

**Why `--import ./dist/instrument.js` first:** Sentry’s Node SDK registers OpenTelemetry instrumentation that must load **before** any other application module (DB pool, Hono, route handlers). If `instrument.js` is imported after those modules, `captureException` can silently drop events. See the comment block in `src/instrument.ts` and [Sentry’s ESM install guide](https://docs.sentry.io/platforms/javascript/guides/node/install/esm/).

### Custom HTTP server: Fastly body drain

`src/index.ts` wraps `@hono/node-server` with a custom `createServer` hook. **This is load-bearing — do not remove it when refactoring.**

Railway routes inbound traffic through **Fastly**, which applies an **idle write-timeout** on request bodies. If the server does async work (e.g. Clerk JWKS verification in `requireAuth`) before consuming the body, backpressure builds in Fastly’s buffer, the connection is closed, and the client sees **`TypeError: Failed to fetch`** with no HTTP status.

The fix: on every incoming TCP connection, **drain the full body into memory immediately**, stash it on `req.rawBody`, then hand off to Hono. `@hono/node-server` detects `rawBody` and uses it instead of re-reading the exhausted stream, so `c.req.parseBody()`, `c.req.json()`, etc. keep working.

This matters most for **multipart song uploads** and any authenticated POST with a body.

### SIGTERM graceful shutdown

On `SIGTERM` (Railway scale-down / redeploy):

1. Stop the in-process scheduler (`scheduler?.stop()`).
2. Log `sigterm_received`.
3. Call `server.close()` — stop accepting new connections, drain in-flight requests.
4. Start a **10 s hard-kill timer** (`sigterm_hard_kill` → `process.exit(1)`).
5. On clean drain: log `server_closed`, clear timer, `process.exit(0)`.

If requests hang past 10 s, the process exits anyway so Railway is not stuck waiting forever.

### Health checks

`GET /health` (`src/app.ts`):

- Runs `SELECT 1` against Postgres.
- **200** `{ "status": "ok" }` when the DB is reachable.
- **503** `{ "status": "degraded", "detail": "db_unreachable" }` when the query throws.

Railway uses `healthcheckPath` (`/health`) and `healthcheckTimeout` (30) from `railway.json`. A deploy that starts but cannot reach the database will fail the health check and roll back to the previous image.

The server binds **`0.0.0.0`** (not `127.0.0.1`) so Railway’s proxy can reach it. Port comes from `PORT` (Railway-injected) or defaults to `3001` locally.

---

## CI and release (GitHub Actions)

File: `.github/workflows/ci.yml`

### `test` job (every push, and PRs to `main`/`dev`)

1. checkout (`fetch-depth: 0`) → pnpm setup → Node **22** (pnpm cache)
2. `pnpm install`
3. `pnpm typecheck`
4. `pnpm lint`
5. `pnpm test:coverage`
6. `pnpm build`

A parallel `security` job delegates to the fleet's shared workflow (`mini-app-polis/.github`).

**CI does not deploy. CI does not run migrations.**

### `release` job (push to `main` only)

Runs after `test` and `security` succeed: `pnpm exec semantic-release` with `GITHUB_TOKEN`. `.releaserc.json` updates `CHANGELOG.md`, bumps `package.json` `version` (no npm publish), commits them, and creates a GitHub release. Releasing does not by itself deploy — Railway reacts to the git push.

### `evaluate` job (after `release`)

Calls the fleet's shared `mini-app-polis/.github/.github/workflows/evaluate.yml@v3`, which asks api-kaianolevine-com to run evaluator-cog's conformance check against the released tree (ecosystem-standards CD-031). It needs the `CI_VALIDATOR_API_KEY` secret. It does not wait for findings — it only fails if the request does not land.

---

## Environment variables

### Railway (API) — set in Railway dashboard / linked secrets

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | **Yes** | Postgres connection string (Railway Postgres plugin or external). |
| `CLERK_JWKS_URL` | **Yes** | Clerk JWKS URL for JWT verification. |
| `CORS_ORIGINS` | **Yes** | Comma-separated browser origins (e.g. `https://deejaytools.com,https://www.deejaytools.com`). |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | **Yes** (for uploads) | Drive service account client email. |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | **Yes** (for uploads) | PEM private key; use `\n` escapes in the env var — code unescapes with `.replace(/\\n/g, "\n")`. |
| `GOOGLE_DRIVE_PARENT_FOLDER_ID` | **Yes** (for uploads) | Root Drive folder ID; folder must be **shared with the service account**. |
| `PORT` | Auto | Injected by Railway; do not hardcode in production. |
| `NODE_ENV` | Auto / set | Typically `production` on Railway. |
| `SENTRY_DSN` | Optional | Enables API Sentry when set. |
| `BREVO_API_KEY` | Optional | Feedback email via Brevo; when unset, feedback still returns 201. |
| `TICK_SECRET` | Optional | When **defined** (even `""`), `GET /internal/tick` requires matching `x-tick-secret`. When **unset**, endpoint is **completely open**. |
| `TICK_INTERVAL_MS` | Optional | Scheduler interval ms (default `30000`). |
| `DISABLE_SCHEDULER` | Optional | Only the literal string `"1"` disables the in-process scheduler. |
| `DB_POOL_MAX` | Optional | Default `20`. Stay under Railway Postgres connection limits. |
| `DB_CONNECT_TIMEOUT` | Optional | Default `10` (seconds). |
| `DB_IDLE_TIMEOUT` | Optional | Default `30` (seconds). |

### Platform-injected (do not set manually unless debugging)

| Variable | Where | Purpose |
|----------|-------|---------|
| `RAILWAY_DEPLOYMENT_ID` | Railway | Primary Sentry release tag on API (`instrument.ts`); falls back to `npm_package_version` when unset. |
| `npm_package_version` | Node / package context | Sentry release fallback on API. |

---

## First deploy to a new environment (runbook)

Do these **in order**:

1. **Postgres** — Provision a database; note the connection string.
2. **Clerk** — Create/configure a Clerk application; note the JWKS URL.
3. **Google Drive** — Create a service account, enable Drive API, download key, create/share parent folder with the service account email.
4. **Railway service** — Connect this repo; ensure `railway.json` is picked up; set env vars (`DATABASE_URL`, `CLERK_JWKS_URL`, `CORS_ORIGINS`, Google vars, optional Sentry/Brevo/TICK_*).
5. **First deploy** — Push to the connected branch. Build runs `pnpm build`; start runs **migrate then start**. Confirm `GET /health` returns `{ "status": "ok" }`.
6. **Note the public API URL** — Railway-generated hostname or custom domain; the web app's `VITE_API_URL` points here.
7. **CORS** — Add the web app's Pages URL (and custom domain) to `CORS_ORIGINS`; redeploy if needed.
8. **Scheduler** — In Railway logs, grep for `scheduler_started`. Optionally hit `GET /internal/tick` with `x-tick-secret` if `TICK_SECRET` is set.
9. **Sentry** — Optionally confirm a test error arrives and the release is tagged.

---

## Related docs

- [`README.md`](../README.md) — env vars and local run
- [`docs/decisions/ADR-001-drizzle-migrations-at-deploy.md`](decisions/ADR-001-drizzle-migrations-at-deploy.md) — migration-at-deploy decision
- [`deejaytools-com` DEPLOYMENT.md](https://github.com/mini-app-polis/deejaytools-com/blob/main/docs/DEPLOYMENT.md) — Cloudflare Pages side
