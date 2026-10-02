# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for this
repository. ADRs document significant architectural decisions, the
context around them, and their consequences.

## Format

Each ADR is a markdown file named `ADR-NNN-title-in-kebab-case.md`
where `NNN` is a zero-padded 3-digit sequence number starting at `001`.
This matches ecosystem-standards DOC-005.

## Template

```markdown
# ADR-NNN. Title of the decision

Date: YYYY-MM-DD

## Status

Proposed | Accepted | Superseded by [ADR-NNN](./ADR-NNN-other.md)

## Context

What is the issue that we're seeing that is motivating this decision?

## Decision

What is the change that we're actually proposing or doing?

## Consequences

What becomes easier or more difficult to do because of this change?
```

## Index

- [ADR-001 — Run Drizzle migrations at Railway deploy time](./ADR-001-drizzle-migrations-at-deploy.md)
- [ADR-002 — Validation 400 responses use the canonical error envelope](./ADR-002-validation-envelope-shape.md)
- [ADR-003 — Clerk verification: session JWTs only, no M2M](./ADR-003-jwt-only-clerk-verification.md)
- [ADR-004 — Floor-trial queue model](./ADR-004-floor-trial-queue-model.md) — superseded by ADR-005
- [ADR-005 — Floor-trial queue model, as built](./ADR-005-floor-trial-queue-model-as-built.md)
- [ADR-006 — Replacement API: a FastAPI service on the existing database](./ADR-006-replacement-api-fastapi-on-existing-database.md)
- [ADR-007 — Replacement API: authorization through the identity library](./ADR-007-replacement-api-identity-authorization.md)
- [ADR-008 — Replacement API: numbered raw-SQL migrations from a baseline](./ADR-008-replacement-api-raw-sql-migrations.md)
- [ADR-009 — Replacement API: wire contract, reuse, and how it is tested](./ADR-009-replacement-api-contract-and-testing.md)
