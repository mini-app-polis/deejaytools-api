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

export { db };

/** Empty every table and the in-memory response cache. Runs before each test. */
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

/** Call the app in-process. Each call gets its own client address so the
 * suite never trips the per-IP rate limit. */
export async function request<T = any>(
  method: string,
  path: string,
  opts: { token?: string | null; body?: Json } = {}
): Promise<ApiResponse<T>> {
  requestCounter += 1;
  const headers: Record<string, string> = {
    "x-forwarded-for": `10.${(requestCounter >> 16) & 255}.${(requestCounter >> 8) & 255}.${requestCounter & 255}`,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
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
