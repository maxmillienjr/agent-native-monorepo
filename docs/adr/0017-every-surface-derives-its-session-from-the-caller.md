# 0017 · Every surface derives its session from the caller

**Status:** accepted
**Date:** 2026-10-12

## Context

[ADR 0014](0014-service-authentication-bearer-at-the-service-open-when-unconfigured.md) made
the principal the unit of ownership on the A2A surface. A context's session id is
`contextSessionId(principal, contextId)`, a UUIDv5, so two principals with one context id
have two conversations. It left `POST /runs` as its first residual: the client names its
`sessionId`, so an authenticated caller can name any session. The ADR priced fixing it as a
change to "the ids the evaluation harness and the inspector read".

P5-D measured both halves on 2026-10-12. The residual was larger than a gap in `/runs`.
The derived A2A id is a function of public inputs, because the namespace is in the
repository and a principal's name is not a secret. Principal `b` computed principal `a`'s
session for one context and sent it to `/runs` as an ordinary `sessionId`. The request
retrieved `a`'s fact and appended a turn to `a`'s conversation, and `a`'s next prompt was
built from that turn. The cost was smaller than ADR 0014 said. The evaluation harness
calls `RunsService` in process and never goes through the controller. No cassette or
baseline holds a session id. The console's inspector reads no session id from the service.

## Decision

**No route takes a storage session id from its caller. Each surface derives the session
from the authenticated principal and the id the client names, before it calls the shared
run loop.**

- **`/runs` derives `runsSessionId(principal, sessionId)`**, a UUIDv5 over
  `principal\nsessionId` in `RUNS_SESSION_NAMESPACE`
  (`apps/agent-service/src/auth/session-scope.ts`). `POST /runs` and `POST /runs/stream`
  both apply it in `RunsController`. The principal is `principalOf(req) ?? OPEN_PRINCIPAL`,
  the rule `mountA2a`'s `userBuilder` applies.
- **It derives in open mode too.** Every caller is then `anonymous`, so the derivation
  separates no one, as ADR 0014 says of open mode. The rule still reads the same in both
  modes, and "no route takes a storage id from a caller" has no exception.
- **The namespace is separate from A2A's.** `/runs` writes the history its client sends
  from turn 0. A2A rebuilds history from episodic memory and needs its turns contiguous. A
  principal's `/runs` session `X` and its A2A context `X` therefore can never be one session.
  `A2A_SESSION_NAMESPACE` and `contextSessionId` do not change, because changing them would
  orphan every A2A session.
- **The response carries the client's id.** A client continues a conversation by sending
  its id again. A derived id sent back would be derived a second time, into a different
  session. `RunResponse.sessionId` keeps its meaning.
- **`RunsService` does not change.** The evaluation harness calls it in process on the
  session its task seeded. A scope applied there would hide the seed and turn every replay
  into a stale-cassette abort. The controller is the HTTP surface's half, as `RunExecutor`
  is A2A's.

The isolation does not rest on the namespace being secret. A caller who computes another
principal's stored id, from either function, gains nothing: its request is derived again,
under its own principal, into a session nobody else reaches.

**This record extends ADR 0014.** ADR 0014's decision that ownership is per principal now
covers `/runs` as well as A2A, and its first residual is closed. Its other residuals stand.

**It narrows one sentence of
[ADR 0007](0007-a-run-record-beside-the-checkpoints-for-audit-replay.md).** ADR 0007's
header holds "the body as received". That now means the body as the run loop received it,
after the surface has scoped it. `run_records.request` and `run_records.session_id` hold
the derived id. A2A has recorded a synthesized body since P5-A, and no record said so.
`audit:replay` re-executes `record.request`, so replay is unaffected. The record's shape is
unchanged, so `RUN_DIGEST_VERSION` stays 1.

Neither ADR 0014 nor ADR 0007 is superseded, because neither decision is reversed. ADR 0008
narrows ADR 0003 the same way, and ADR 0015 narrows ADR 0010.

## Alternatives rejected

- **An ownership table.** Map each client id to the principal that first used it, and
  refuse anyone else. This is a new write from app code, which `CLAUDE.md` routes through
  `memory-core`, and a read before every run's `ingress`. It also needs a policy for the
  first caller to name an id, which is the first-write-wins problem moved to a new table.
- **Server-minted session ids.** The service issues the id, and the client may only send
  one it was given. This changes the contract, and it needs a route that lists a caller's
  sessions or a client that keeps them. The derivation closes the hole without either.
- **Sharing A2A's namespace.** A principal's A2A context and its `/runs` session of the
  same string would be one session, and `/runs` writing turns from 0 would collide with the
  contiguous history `rebuildHistory` requires.
- **Returning the derived id.** A client that copied it into its next request would be
  derived again, into a different session, and its conversation would be lost.
- **Scoping inside `RunsService`.** This catches every caller, the evaluation harness
  included. The harness seeds memory under the task's id, so it would read nothing, and
  every replay would abort on a stale cassette.
- **The body as sent plus a `principal` column.** This keeps ADR 0007's sentence literally
  true, and replay derives the session again from the record. It costs a `memory-core`
  migration, a `RunRecordOpenSchema` field, `RUN_DIGEST_VERSION` 2 and a verifier for both
  versions. It also answers "who asked" for both surfaces, which is a question about the
  record and not about `/runs`. Decided at P5-D's review: not here.

## Consequences

**What it buys.** "Every conversation belongs to the principal that started it" is true of
the whole service, not of one route. CTL-ACC-04 is `implemented`, anchored on integration
tests that run P5-D's measurement in reverse against live stores. CTL-ACC-02's isolation
can no longer be bypassed through `/runs`.

**What it costs.**

- **The client's id is no longer the storage key.** A reader who checks the quickstart
  with `psql` finds the README's `550e8400-…` in no `episodes` row. The storage key is
  `run_records.session_id` for the response's `runId`, and that is how an operator traces a
  client's session. The `audit` log line's `sessionId` is still the client's.
- **Data written before this landed is unreachable through `/runs`.** It is not deleted.
  Nothing here is deployed, and the compose volumes are throwaway.

**What remains, stated as residuals.** Each one has no owning PRD.

- **Open mode collapses every caller into `anonymous`.** Two open-mode callers who send one
  id share a session, as before.
- **The console has no user login.** Every console user is the principal `console`, kept
  apart from another only by the random id `RunForm` generates.
- **Who asked is not in the run record**, on either surface.
- **`semantic_facts` keeps its first writer's session.** If `b` extracts a fact first, `a`'s
  later extraction of the same text lands on `b`'s row, and `a`'s retrieval no longer finds
  it. That is a loss of recall and discloses nothing.
- **`/runs` does not serialize concurrent runs in one session**, as the A2A executor does.
  That is within one principal, and it predates this record.

**Revisit when** a second surface takes a session from a caller, or when the principal
stops being the unit of ownership. A JWT `sub` replacing the opaque token's name is neither:
the derivation takes whatever string identifies the principal.
