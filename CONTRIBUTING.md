# Contributing

How to work in this repo. Details live in the README and docs linked below — this file is the map, not a second copy of them.

## Prerequisites and first-time setup

- **Node.js 22+**, **pnpm 9** (`packageManager` in `package.json`).
- Clone, then:

```bash
pnpm install
cp .env.example .env
# Fill DATABASE_URL and CLERK_JWKS_URL at minimum
pnpm db:migrate
```

- **Run:** `pnpm dev` (port 3001). The web app lives in [`deejaytools-com`](https://github.com/mini-app-polis/deejaytools-com/blob/main/) and proxies `/v1` to this port.

Full stack notes, route inventory, and env var semantics:

- [`README.md`](README.md)
- [`docs/API.md`](docs/API.md)

Deploy and ops: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Commits and releases

We use [Conventional Commits](https://www.conventionalcommits.org/). On push to **`main`**, CI runs **`semantic-release`** (`.releaserc.json`) after verify succeeds.

### Prefixes that trigger a version bump

Default `@semantic-release/commit-analyzer` (Angular preset) — no custom overrides in this repo:

| Commit prefix | Version bump | Example |
|---------------|--------------|---------|
| `feat:` | **Minor** (`1.2.0` → `1.3.0`) | `feat: add manager event-songs export` |
| `fix:` | **Patch** | `fix: reject empty partner last name` |
| `perf:` | **Patch** | `perf: batch queue depth queries` |
| footer `BREAKING CHANGE:` | **Major** | see [Forcing a major](#forcing-a-major) |
| `revert:` | **Patch** | `revert: feat: …` |

These **do not** cut a release by themselves: `docs:`, `chore:`, `style:`, `refactor:`, `test:`, `build:`, `ci:`.

Use imperative mood and a short scope when helpful: `fix(queue): …`, `feat(songs): …`.

### Forcing a major

A **`BREAKING CHANGE:` footer is the only way** to cut a major in this repo:

```
feat: replace the event submission contract

BREAKING CHANGE: GET /v1/event-song-submissions now returns division groups
instead of a flat list.
```

Blank line before the footer, uppercase, and a **space** — not a hyphen. The
header type does not matter: `fix:` with that footer still cuts a major.

**`feat!:` does not work here, and it fails silently.** The pinned parser
(`conventional-changelog-angular@8.3.0`) uses

```js
headerPattern: /^(\w*)(?:\((.*)\))?: (.*)$/,
noteKeywords: ['BREAKING CHANGE'],
```

which has no slot for `!`. A `feat!:` header does not match at all, so the
commit is not even recognised as a `feat` — it produces **no release**, not a
minor. `BREAKING-CHANGE:` (hyphen) likewise misses `noteKeywords` and falls
back to whatever the header alone earns.

Behaviour of the installed analyzer, not the spec:

| Commit | Result |
|--------|--------|
| `feat!: …` | **no release** |
| `feat(app)!: …` | **no release** |
| `feat: …` + `BREAKING CHANGE:` footer | **major** |
| `fix: …` + `BREAKING CHANGE:` footer | **major** |
| `feat: …` + `BREAKING-CHANGE:` footer | minor |

If the pinned preset is ever upgraded to one with a `breakingHeaderPattern`,
re-check this table — `!` support is what changes between preset versions.

### What the release job writes

Automatically on release:

- Root **`CHANGELOG.md`** (via `@semantic-release/changelog`)
- Root **`package.json` `version`** (via `@semantic-release/npm`, publish disabled)
- Git commit `chore(release): X.Y.Z` with those files
- GitHub Release

**Do not hand-edit `CHANGELOG.md` or bump `package.json` version in feature PRs** — the release bot will conflict.

---

## CI verify pipeline

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and PR. Reproduce a failure locally in **the same order**:

| CI step | Local equivalent |
|---------|------------------|
| 1. Install | `pnpm install` |
| 2. Typecheck | `pnpm typecheck` |
| 3. Lint | `pnpm lint` |
| 4. Tests + coverage | `pnpm test:coverage` |
| 5. Build | `pnpm build` |

CI does **not** deploy and does **not** run production migrations ([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).

---

## Where new code goes

| Change | Location | Also update |
|--------|----------|-------------|
| **New route** | `src/routes/<name>.ts` → mount in `src/app.ts` | Route test alongside (`*.test.ts`); see [Testing](#testing) |
| **Helper** | `src/lib/` or `src/services/` | Unit test under same tree |
| **API contract shape (request/response Zod schema)** | `src/schemas/index.ts` | This is a copy — the web app keeps its own in `deejaytools-com/src/schemas`. Change both when the contract changes; contract tests (`*.contract.test.ts`) guard this side |
| **Cross-project generic util** | **[`common-typescript-utils`](https://www.npmjs.com/package/common-typescript-utils)** (external npm), **not** this repo | Logger, `{ data, error }` envelopes, `verifyClerkToken`, generic Zod helpers |

---

## Testing

Follow existing patterns; do not introduce a new test stack.

- **Drizzle mock:** `src/test/mocks.ts` — chained `createMockDb()`, queue SELECT results with **`enqueueSelectResult`**, auth stubs **`mockRequireAuth`** / **`mockRequireAdmin`**.
- **Route test templates** (from [`README.md`](README.md)):
  - `routes/checkins.test.ts` — authenticated mutation
  - `routes/admin-checkins.test.ts` — admin-only; cover 403 / 401 / 400 / 404
  - `routes/runs.test.ts` — complex JOIN read
  - `lib/queue/*.test.ts` — pure / lightly mocked helpers
- Run: `pnpm test` or `pnpm test:coverage`.

Add tests for new routes and non-trivial lib changes. Handlers that map errors to HTTP should log a route-specific `*_failed` event (see existing routes).

---

## Architecture Decision Records (ADRs)

Format and index: [`docs/decisions/README.md`](docs/decisions/README.md). Template: **Context → Decision → Consequences**, status line, date.

**Naming:** `ADR-NNN-short-kebab-title.md` — **NNN** is a zero-padded three-digit sequence starting at `001`.

**Write an ADR when:**

- The decision has **lasting architectural tradeoffs** (deploy model, auth model, queue semantics, observability stack).
- You are **exempting** the repo from an ecosystem standard and need rationale on record (see existing ADR-001 migration-at-deploy, ADR-003 JWT-only).
- A future contributor would reasonably ask **“why not the obvious alternative?”**

**Skip an ADR for:** bug fixes, routine endpoints, refactors that follow established patterns, dependency bumps, copy changes — a good Conventional Commit and PR description is enough.

Add the new file to the **Index** section of `docs/decisions/README.md`.

---

## Documentation expectations

Keep docs in sync with behaviour — reviewers should block merges that change contracts without doc updates.

| Kind of change | Update |
|----------------|--------|
| New or changed endpoint | [`docs/API.md`](docs/API.md) |
| DB table/column/convention | [`docs/SCHEMA.md`](docs/SCHEMA.md) + Drizzle migration (`pnpm db:generate`) |
| Auth / roles / guards | [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) |
| New **env var** | **`.env.example`**, env tables in **`README.md`** (and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) if production-facing) |
| Significant architecture call | ADR in `docs/decisions/` |

---

## Pull requests

- Target **`main`**. Ensure the verify pipeline passes locally before pushing.
- One logical change per PR when possible; link related issues if any.
- For release-visible work, use `feat:` / `fix:` prefixes so semantic-release can version correctly.

Questions about deployment or production errors: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).
