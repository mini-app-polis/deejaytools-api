import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Route coverage for the integration suite: every route the app registers
 * must be called by at least one integration test, or be listed in
 * NOT_EXERCISED with the reason it is not. Checked once the whole suite has
 * run (global-setup.ts's teardown), so a new route without a real-database
 * test — or a stale entry here — fails CI.
 *
 * This is how coverage is enforced here, rather than by a percentage: what
 * matters is that every endpoint has been driven against real Postgres at
 * least once, and that every gap is written down on purpose.
 */

/** "METHOD /path/pattern" → why no integration test calls it (yet). */
export const NOT_EXERCISED: Record<string, string> = {};

// Hits and the route table are shared through files in one directory: each
// test file runs in its own module scope, and the check runs in the main
// process. Global setup creates the directory and hands it to the workers.
let HITS_FILE = "";
let ROUTES_FILE = "";

export function useLedgerDir(dir: string): void {
  HITS_FILE = `${dir}/route-hits.txt`;
  ROUTES_FILE = `${dir}/routes.txt`;
}

/** Called by the harness for every request a test makes. */
export function recordHit(method: string, path: string): void {
  if (HITS_FILE) appendFileSync(HITS_FILE, `${method.toUpperCase()} ${path.split("?")[0]}\n`);
}

/** Called once per test file with the app's route table. */
export function recordRoutes(routes: { method: string; path: string }[]): void {
  if (!ROUTES_FILE) return;
  const lines = routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
  writeFileSync(ROUTES_FILE, [...new Set(lines)].join("\n"));
}

function toMatcher(pattern: string): { pattern: string; re: RegExp; params: number } {
  const [method, path] = pattern.split(" ");
  const params = (path.match(/:[^/]+/g) ?? []).length;
  const body = path.replace(/[.+*?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+");
  return { pattern, re: new RegExp(`^${method} ${body}$`), params };
}

/** The route pattern a concrete request matched: the most specific one, as
 * the router picks a static segment over a parameter. */
export function matchRoute(hit: string, patterns: string[]): string | undefined {
  return patterns
    .map(toMatcher)
    .filter((m) => m.re.test(hit))
    .sort((a, b) => a.params - b.params)[0]?.pattern;
}

/** The problems with the ledger once the suite has run; empty when it holds. */
export function ledgerProblems(): string[] {
  if (!existsSync(ROUTES_FILE)) return ["The route table was never recorded; did any integration test run?"];
  const routes = readFileSync(ROUTES_FILE, "utf8").split("\n").filter(Boolean);
  const hits = existsSync(HITS_FILE) ? readFileSync(HITS_FILE, "utf8").split("\n").filter(Boolean) : [];
  const exercised = new Set(hits.map((h) => matchRoute(h, routes)).filter((r): r is string => !!r));

  const problems: string[] = [];
  for (const route of routes) {
    if (!exercised.has(route) && !(route in NOT_EXERCISED)) {
      problems.push(`${route} — no integration test calls it. Add one, or list it in NOT_EXERCISED with the reason.`);
    }
  }
  for (const route of Object.keys(NOT_EXERCISED)) {
    if (!routes.includes(route)) problems.push(`${route} is in NOT_EXERCISED but the app has no such route.`);
    else if (exercised.has(route)) problems.push(`${route} is in NOT_EXERCISED but a test now calls it; remove the entry.`);
  }
  return problems;
}
