import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./db-errors.js";

describe("isUniqueViolation", () => {
  const pgError = { code: "23505", constraint_name: "users_email_unique" };

  it("matches the Postgres error itself", () => {
    expect(isUniqueViolation(pgError)).toBe(true);
  });

  it("matches it on the cause of a wrapping error, as Drizzle throws it", () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: pgError });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, "users_email_unique")).toBe(true);
    expect(isUniqueViolation(wrapped, "uq_teams_user_identifier")).toBe(false);
  });

  it("does not match other errors", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});
