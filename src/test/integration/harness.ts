/* eslint-disable @typescript-eslint/no-explicit-any --
 * Response bodies default to `any` so tests can assert on them field by
 * field; the schemas they are checked against live in the tests. */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { app } from "../../app.js";
import { db } from "../../db/index.js";
import { songs, users } from "../../db/schema.js";
import { responseCache } from "../../lib/cache.js";
import { tokenFor } from "./clerk.js";
import { recordHit } from "./route-ledger.js";
import { integrationBaseUrl } from "./target.js";

export { app, db };

/** Origin of a separately started API to drive over HTTP, or undefined to
 * call the app in-process. See target.ts and docs/CONFORMANCE.md. */
export const baseUrl = integrationBaseUrl();
/** True when requests go over HTTP to `baseUrl`. Tests that need in-process
 * stand-ins (the mocked Drive calls) skip themselves on this. */
export const overHttp = baseUrl !== undefined;

/** Empty every table and the in-memory response cache. Runs before each test.
 * Over HTTP only the tables can be reset; the target's own response cache
 * (3–5 s TTLs) carries over between tests. See docs/CONFORMANCE.md. */
export async function resetDatabase(): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const tables = [...rows].map((r) => `"${r.tablename}"`);
  if (tables.length) {
    await db.execute(sql.raw(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`));
  }
  responseCache.invalidatePrefix("");
}

type Json = Record<string, unknown> | unknown[];

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

let requestCounter = 0;

/** Call the API: in-process by default, over HTTP to `baseUrl` when set.
 * Each call gets its own client address so the suite never trips the per-IP
 * rate limit (an HTTP target must take the client address from
 * X-Forwarded-For, as this API does behind Railway). */
export async function request<T = any>(
  method: string,
  path: string,
  opts: { token?: string | null; body?: Json; form?: FormData; headers?: Record<string, string> } = {}
): Promise<ApiResponse<T>> {
  requestCounter += 1;
  const headers: Record<string, string> = {
    ...opts.headers,
    "x-forwarded-for": `10.${(requestCounter >> 16) & 255}.${(requestCounter >> 8) & 255}.${requestCounter & 255}`,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  recordHit(method, path);
  // A multipart form sets its own Content-Type, boundary included.
  const init: RequestInit = {
    method,
    headers,
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  };
  const res = baseUrl ? await fetch(`${baseUrl}${path}`, init) : await app.request(path, init);
  const text = await res.text();
  let body: T;
  try {
    body = (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body };
}

/**
 * One scheduler pass (session statuses, queue auto-fill, Drive jobs), through
 * GET /internal/tick so an HTTP target runs its own. Neither mode runs the
 * background scheduler during tests, so this is the only thing that advances
 * the queue. Sends INTEGRATION_TICK_SECRET as x-tick-secret when set.
 */
export async function tick(): Promise<void> {
  const secret = process.env.INTEGRATION_TICK_SECRET;
  const res = await request("GET", "/internal/tick", {
    headers: secret === undefined ? undefined : { "x-tick-secret": secret },
  });
  if (res.status !== 200) {
    throw new Error(`GET /internal/tick failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** A signed-in user: synced through the real /auth/sync, optionally made admin. */
export interface Actor {
  id: string;
  email: string;
  token: string;
  get<T = any>(path: string): Promise<ApiResponse<T>>;
  post<T = any>(path: string, body?: Json): Promise<ApiResponse<T>>;
  patch<T = any>(path: string, body?: Json): Promise<ApiResponse<T>>;
  del<T = any>(path: string): Promise<ApiResponse<T>>;
}

export async function actor(
  name: string,
  opts: { admin?: boolean; sync?: boolean } = {}
): Promise<Actor> {
  const id = `user_${name}_${randomUUID().slice(0, 8)}`;
  const email = `${name}.${randomUUID().slice(0, 8)}@example.test`;
  const token = await tokenFor(id);
  const a: Actor = {
    id,
    email,
    token,
    get: (p) => request("GET", p, { token }),
    post: (p, b) => request("POST", p, { token, body: b ?? {} }),
    patch: (p, b) => request("PATCH", p, { token, body: b ?? {} }),
    del: (p) => request("DELETE", p, { token }),
  };
  if (opts.sync !== false) {
    const res = await a.post("/v1/auth/sync", { email, firstName: name, lastName: "Tester" });
    if (res.status !== 200) throw new Error(`sync for ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (opts.admin) {
    // Admins are promoted in the database, as in every environment.
    await db.execute(sql`UPDATE ${users} SET role = 'admin' WHERE id = ${id}`);
  }
  return a;
}

/**
 * Songs normally arrive through the Drive upload flow, which is out of scope
 * here; insert one directly, attached to a partner.
 */
export async function seedSong(userId: string, partnerId: string, division = "Classic"): Promise<string> {
  const id = `song_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await db.insert(songs).values({
    id,
    userId,
    partnerId,
    division,
    displayName: "Integration Song",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** The timezone test events are created in (the API's default). */
export const TEST_TIMEZONE = "America/Chicago";

/**
 * Dates for a test event: yesterday through tomorrow in the event's own
 * timezone. The API checks session times against the event's dates in that
 * timezone, so dates built in UTC break every evening in Chicago, when UTC
 * has already reached tomorrow; and a session near now can cross midnight
 * either way.
 */
export function eventDates(): { start_date: string; end_date: string; timezone: string } {
  const day = (offset: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TEST_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Date.now() + offset * 86_400_000));
  return { start_date: day(-1), end_date: day(1), timezone: TEST_TIMEZONE };
}
