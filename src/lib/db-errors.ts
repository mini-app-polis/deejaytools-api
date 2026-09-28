/**
 * Whether `err` is Postgres's unique-constraint violation (SQLSTATE 23505),
 * optionally on a specific constraint.
 *
 * Drizzle wraps driver errors in its own error (DrizzleQueryError) and keeps
 * the Postgres error on `cause`, so the code has to be looked for down the
 * cause chain, not only on the error itself. Checking `err.code` alone never
 * matches a query error, which quietly turned every "already exists" 409 into
 * a 500.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; depth += 1) {
    const pg = e as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (pg.code === "23505") {
      return constraint === undefined || pg.constraint_name === constraint;
    }
    e = pg.cause;
  }
  return false;
}
