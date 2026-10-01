# deejaytools-com — design decisions

This codebase replaced **`routine-management-platform`**, which ran on Cloudflare Workers + D1.

## Stack choices

**Hono on Node over Cloudflare Workers**
The original `routine-management-platform` ran on Cloudflare Workers with D1 (SQLite). Replaced with Hono on Node deployed to Railway. Reasons: Railway is the ecosystem standard for all API services, Workers has compute/duration limits that constrain real-time floor trial logic, and moving off D1 allows PostgreSQL as the universal database standard.

**Drizzle ORM over raw SQL**
Drizzle gives TypeScript-native schema definitions, migration management via Drizzle Kit, and explicit query building that stays close to SQL without hiding it. Consistent with SQLAlchemy on the Python side — both are explicit-first ORMs.

**PostgreSQL over D1**
D1 is a Workers-specific constraint. PostgreSQL on Railway is the ecosystem standard for all new services. The schema migrated cleanly from the D1 SQL migrations.

## API design

**Resource-oriented routes over session-nested routes**
The old platform nested routes under sessions (e.g. `/api/sessions/:id/checkin`). The new platform uses flat resource routes (`/v1/checkins?session_id=`). More consistent, easier to extend, and cleaner for the frontend to reason about.

**Queue model: superseded — see ADR-005**
Earlier versions of this file recorded three decisions that no longer hold: a `standard` queue type (the value is `non_priority` again since migration `0003`), a caller-supplied `queue_type` (admission is decided server-side), and `pair_id` / `partner_id` on `POST /v1/checkins` (the body takes exactly one of `entityPairId`, `entitySoloUserId`, `entityManagedPartnershipId`). The as-built model is [ADR-005](./decisions/ADR-005-floor-trial-queue-model-as-built.md); request shapes are in [API.md](./API.md).

## Shared library

**common-typescript-utils (npm) + src/schemas (local copy)**
Generic cross-project utilities (structured logger, success/error envelopes, Clerk `verifyClerkToken`, `UserRoleSchema`, pagination helpers) ship as [`common-typescript-utils`](https://www.npmjs.com/package/common-typescript-utils) on npm. Deejaytools-specific Zod enums (`SessionStatusSchema`, `DivisionSchema`, `PartnerRoleSchema`, etc.) live in `src/schemas`. The web app (`deejaytools-com`) keeps its own copy in its `src/schemas`; the two are kept in step by hand, and the `*.contract.test.ts` suites guard this side. They stay out of the generic library to avoid coupling domain types to it.

## Observability

**Three-layer stack**
Layer 1 (liveness): Railway auto-restart. Layer 2 (structured logs): `common-typescript-utils` logger emitting JSON with standard shape. Layer 3 (exceptions): Sentry capturing unhandled errors. Each layer covers a distinct failure mode.

**Session status via in-process scheduler**
Session status transitions (`scheduled` → `checkin_open` → `in_progress` → `completed`) and active-queue auto-fill are driven by `startScheduler()` in `index.ts` — an in-process `setInterval` loop (default 30 000 ms, configurable via `TICK_INTERVAL_MS`), disabled only when `DISABLE_SCHEDULER === "1"` (the exact string; `"true"` does **not** disable it). The loop has an overlap guard (`running` flag) and calls `handle.unref()` so it never keeps the process alive at shutdown. Each tick runs `tickSessionStatuses()` then `fillRunningSessions()`, then drains one batch of the Drive job queue with `processDriveJobs()` (all via the shared `runTick()` helper). Session work and Drive work sit in separate `try` blocks, so a persistent failure in one never stops the other. The Drive queue is specified in [DRIVE.md](./DRIVE.md#drive_jobs-queue).

`tickSessionStatuses()` advances **one step per session per tick**, so a dormant session that needs to walk the full chain can take up to three ticks to reach `completed`. The persisted DB status is updated for side effects, but **clients never see it directly**: `deriveSessionStatus()` in `routes/sessions.ts` recomputes status from the wall clock on every response, so a lagging or disabled scheduler never shows a wrong status in the UI. `cancelled` is a manual admin override and is preserved by both paths.

`GET /internal/tick` is a **manual override** for an operator or external monitor, not the primary driver. It runs the same `runTick()` pass. It is gated by the `x-tick-secret` header using a `!== undefined` check on `TICK_SECRET`, so an empty-string secret still gates; if `TICK_SECRET` is unset the endpoint is completely open (deployment warning).

Multi-replica safety: `tickSessionStatuses()` is idempotent, and `fillActiveQueue` takes `SELECT … FOR UPDATE` per session via `lockSessionForFill()`.

## Music management

**Partner dance role on the partner record, not the user**
Each partner relationship has a `partner_role` field (`leader` | `follower`) representing the partner's role. The uploading user's role is always the opposite. This allows the same user to be a leader with one partner and a follower with another. The role lives on the partner record rather than the user because it varies per relationship.

**Filename ordering: leader first, except ProAm FollowerAm**
Processed filenames put the leader name first regardless of who uploaded the song. The server resolves ordering at upload time based on `partner_role`: if the partner is a follower, the uploading user is the leader (user name first); if the partner is a leader, the uploading user is the follower (partner name first). Solo, team and other uploads use one name. In the `ProAm FollowerAm` division the follower (the amateur) is named first instead. The title tag uses the same order.

Format: `{first}_{second}_{division}_{seasonYear}_{routineName}_{descriptor}_v{NN}.{ext}`. The full rules (sanitizing, versioning, extensions) are in [DRIVE.md](./DRIVE.md#background-build-buildanduploadsong).

**Chunked upload, Drive work in the background**
Songs are uploaded through one endpoint, `POST /v1/songs/upload/chunk`, in chunks of up to 10 MB (at most 30). Chunks are staged on local disk; nothing touches the database until the final chunk arrives. That request reassembles the file, checks its format by magic bytes, inserts the song row and **responds immediately**. Tagging, the Drive upload and sharing then run in the background, because a large Drive upload (30–120 s) held the request open long enough for clients to drop it. If the background work fails, the server deletes the song row; the user sees the song disappear and retries.

The trade-off: the row briefly exists without Drive fields, and a process restart mid-upload leaves it that way. (`POST /v1/songs` still exists for metadata-only rows; there is no `/v1/songs/:id/upload` route.) Details: [DRIVE.md](./DRIVE.md#upload-pipeline).

**Event copies through a durable job queue**
Submitting a song to an event copies its file into that event's Drive folder, and removing the submission deprecates the copy. These are queued as `drive_jobs` rows and run by the scheduler tick with retry and backoff, not inline: a Drive outage during the pre-event submission rush must not fail or slow submissions, and a copy must survive a deploy mid-flight. See [DRIVE.md](./DRIVE.md#drive_jobs-queue).

**Per-format audio tagging**
ID3v2.3 for MP3 (via `node-id3`) and for WAV (an `id3 ` RIFF chunk). Vorbis comments (via `flac-tagger`) for FLAC. iTunes-style `ilst` atoms (hand-written parser) for m4a. Every file gets title (the entity), artist (`division | routine`), genre `_Routine_` and the season year; whatever title/artist/album the file arrived with is kept in the comment as `title=…,artist=…,album=…`. Tagging never fails an upload: anything it can't handle goes through untagged. The field-level spec is [AUDIO-TAGGING.md](./AUDIO-TAGGING.md).

**Divisions list hardcoded**
The 15 WCS divisions are hardcoded in the frontend. Admin-configurable divisions are deferred — when the floor trial UX is revisited, a divisions management UI should be part of that pass since session divisions and song divisions share the same list.
