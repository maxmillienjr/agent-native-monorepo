# 0013 · The decision ledger is written by a role that cannot rewrite it

**Status:** accepted
**Date:** 2026-10-08

## Context

P3-C adds a hash-chained ledger that commits to every run record, every recommendation on
the prior-authorization path, and every clinician's signed determination. Its value is that
nobody who writes it can change what it already holds without the change being found.

Two rules already govern database writes here. `CLAUDE.md` says all memory writes go
through `packages/memory-core`, and `.agents/reviewer.md` rule 4 forbids database calls
outside it. Both were written when `memory-core` was the only writer. They were already
inexact: the checkpointer writes its own three tables from
`apps/agent-service/src/memory/memory.module.ts`, an exception no document stated.

Three facts about Postgres decide what a ledger in it can promise. Each was probed on
`pgvector/pgvector:pg16` and is now an integration test in
`packages/decision-ledger/test/ledger.integration.test.ts`. A role granted only `SELECT`
and `INSERT` gets `permission denied` on `UPDATE`, `DELETE` and `TRUNCATE`. A
`BEFORE UPDATE OR DELETE` trigger stops the table's owner. And a superuser who sets
`session_replication_role = replica` rewrites a row anyway.

So the database can stop the service rewriting history, and cannot stop a database
administrator. Memory's writes are upserts and need `UPDATE`. The checkpointer needs
`UPDATE` and `DELETE` on its own tables. The ledger's writer must have neither. One pool
cannot be all three.

## Decision

**The ledger is its own package, `@repo/decision-ledger`, written through its own pool as
`ledger_writer`, a role with `SELECT` and `INSERT` on the ledger's tables and nothing
else.**

- The package boundary follows the role boundary, because a reviewer can check a package
  boundary. `@repo/decision-ledger` owns its migrations, recorded in
  `drizzle.__ledger_migrations` rather than memory's table, and a `roles.sql` that creates
  the role. Its runtime dependencies are `pg`, `zod`, `drizzle-orm` and
  `@repo/determination`, so an auditor can lift it out with the rows it verifies.
- The service reads `LEDGER_DATABASE_URL` and never falls back to `DATABASE_URL`. A ledger
  written with the memory role is one its writer can rewrite. At boot the service refuses a
  role that holds `UPDATE`, `DELETE`, `TRUNCATE` or ownership of `ledger_entries`. The
  service does not migrate the ledger, because its role cannot. `yarn ledger:migrate` does
  that as the owner.
- **Three packages own database writes**, and the rules now name all three:
  `packages/memory-core` for memory and for the run record and case table written with
  the service's role; the LangGraph checkpointer for its own tables; and
  `packages/decision-ledger` for the ledger. `CLAUDE.md`'s first key rule and reviewer
  rule 4 are amended to say so.
- The agent cannot reach the ledger. The service's ESLint config forbids
  `@repo/decision-ledger` under `src/agent/`, as it forbids P3-A's clinician constructor
  there. The ledger is appended to after a run settles, outside the graph, and nothing in
  the graph reads it, so it is not a memory tier.
- What the role cannot stop, an anchor detects. `ledger:anchor` time-stamps the head with
  an RFC 3161 authority, and `ledger:verify` checks every token against the authority's CA.
  A rewrite of any entry at or before an anchored one fails that check. A consistent
  rewrite confined to entries after the last anchor is caught by nothing, and the verifier
  names that window in every report.

## Consequences

- A reviewer applying rule 4 now accepts database calls in `packages/decision-ledger` and
  rejects them in `apps/`. The service builds its ledger pool with the package's
  `createLedgerPool` and never imports `pg` itself.
- `memory-core` still holds P3-B's run record and P3-E's case table. Both are written by
  the service's own role and need `UPDATE`, so by this record's test they belong there.
- `@repo/decision-ledger` is the second package with an `exports` map. Its `./testing`
  subpath holds a time-stamping authority whose CA key sits in a temporary directory. That
  subpath is kept out of the barrel for the same reason the clinician subpath is, and the
  lint rule names it too.
- The guarantee is only as good as the anchors' custody. If nobody outside the database
  administrator's control archives the tokens, the ledger detects nothing that
  administrator does. `.context/conventions.md`, Before real data, says so, and names
  scheduled anchoring to two independent authorities as the production posture.

## Revisit when

A party must check one determination without being shown the rest of the log, for example
a member's appeal. A hash chain cannot give that proof, and an RFC 9162-style Merkle tree
with inclusion proofs would replace the chain under a new PRD. Revisit too if a deployment
holds the ledger in a service the operator cannot administer, such as an append-only
cloud log. The role then stops mattering, and the package boundary may not.
