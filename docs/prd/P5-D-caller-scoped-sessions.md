---
id: P5-D
title: Scope POST /runs sessions to the authenticated caller
tier: 5
status: in-progress
size: S
depends_on: [P5-A]
blocks: []
issue: 125
superseded_by: null
controls: [CTL-ACC-04]
---

# P5-D · Caller-scoped sessions on `POST /runs`

## Problem

`POST /runs` and `POST /runs/stream` let the caller choose the session they read and write,
and that includes a session another caller owns. P5-A closed this on the A2A surface and
left it open on `/runs`, and ADR 0014 records it as a residual with no owner. That record
treats it as a gap in `/runs` alone. It is also a way around the A2A isolation that
CTL-ACC-02 marks `implemented`.

**The client names the session.** `RunRequestSchema`
(`packages/agent-contracts/src/run-request.schema.ts`) has a `sessionId: UuidSchema` that
the caller fills in. `RunsController.createRun` and `RunsController.streamRun`
(`apps/agent-service/src/runs/runs.controller.ts`) pass the validated body to `RunsService`
unchanged, and `ingressNode` (`apps/agent-service/src/agent/nodes/ingress.node.ts`) copies
`request.sessionId` into the graph state. Every node downstream reads the session from that
state. `retrieveNode` scopes the pgvector search to `state.sessionId`. `reflectNode` writes
every message to `episodes` under `(state.sessionId, turnIndex)`, and writes facts to
`semantic_facts` and to the graph under the same session. The authentication middleware,
`requireCredential` (`apps/agent-service/src/auth/require-credential.ts`), attaches a
principal to the request, and nothing on the `/runs` path reads it.

**The A2A surface derives its session, and `/runs` accepts the derived id.** The A2A
executor, `RunExecutor.execute` (`apps/agent-service/src/a2a/run-executor.ts`), computes
`contextSessionId(principal, contextId)` (`apps/agent-service/src/a2a/session-id.ts`).
That is a UUIDv5 in `A2A_SESSION_NAMESPACE`, a constant in source, over the principal and
the context id. It then passes the result to `RunsService.run` as `body.sessionId`. Two
principals with one context id therefore get two sessions. But the derived id is a function
of public inputs: the namespace is in the repository, and a principal's name is not a
secret. A caller who knows another principal's name and one of its context ids can compute
that principal's session id. `/runs` then accepts it as an ordinary `sessionId`.

**Measured on 2026-10-12 at `fba5763`.** The service ran from `dist/main.js` with no
`GOOGLE_API_KEY` (model `stub`). Memory was `live`, against throwaway Postgres and Neo4j
containers. `SERVICE_CREDENTIALS` named two principals, `a` and `b`. There were zero
`generateContent` calls.

1. Principal `a` sent an A2A `SendMessage` in a fresh `contextId`. Its `run` artifact
   reported `messageCount: 1`.
2. Principal `b` computed `contextSessionId('a', contextId)` by importing the function from
   `dist/a2a/session-id.js`. It then sent `POST /runs` with that `sessionId` and three
   messages, the third reading `INJECTED BY PRINCIPAL b`. The response was `200`. Its
   `retrievedContext` held one fact whose `episodeId` was `a`'s first run. The same request
   from `b` with a fresh `sessionId` retrieved nothing.
3. Principal `a` sent a second message in the same context. Its `run` artifact reported
   `messageCount: 5` where P5-A's compose check expects `3`. The `episodes` rows for `a`'s
   session were turns 0–5. Turns 2 and 3 carried `b`'s run id, and turn 2 was
   `INJECTED BY PRINCIPAL b`.

So `b` read `a`'s semantic memory and wrote a turn into `a`'s conversation, and `a`'s next
prompt was built from it (`rebuildHistory`, `apps/agent-service/src/a2a/history.ts`). The
first-write-wins rule on `(session_id, turn_index)` (`DrizzleEpisodicRepository.write`,
`packages/memory-core/src/episodic/episodic.repo.ts`) drops `b`'s copies of turns 0 and 1.
Any turn beyond the end of `a`'s conversation is appended.

**The cost ADR 0014 gives for fixing it is smaller than stated.** The ADR says scoping
`/runs` "would change the ids the evaluation harness and the inspector read". Checked
against HEAD:

- **The evaluation harness does not go through `/runs`.** `AgentServiceHarness.tracedRun`
  (`apps/agent-service/src/eval/agent-harness.ts`) calls `RunsService.executeTraced`
  in process, with `task.input` as the body. It does not go through the controller or the
  authentication middleware. `AgentServiceHarness.reset` seeds memory under
  `task.input.sessionId` through `PgNeo4jSeedManager`
  (`packages/memory-core/src/inspect/seed-manager.ts`). The ablation and explanation
  commands also run in process (`run-retrieval-ablation.ts`, `run-explanation.ts`).
- **No cassette and no baseline holds a session id.** `sessionId` occurs zero times in
  `packages/eval-harness/datasets/memory-recall/cassettes/*.json` and in
  `baselines/replay.json`. A decision's key is `requestHash`
  (`packages/agent-cassette/src/hash.ts`), taken over the seam's request. No prompt
  contains the session id: `planNode`, `actNode` and `distillNode` put it on a span
  attribute only. The session still matters indirectly. Retrieval reads the seeded facts
  by session, and those facts reach `plan`'s prompt. A scope applied below the controller
  would hide the seed and turn every replay into a stale-cassette abort. So the scope has
  to be applied at the HTTP layer, and that is a constraint on the design. Applied there,
  it changes no evaluation input.
- **The console's inspector reads no session id from the service.** `App`
  (`apps/console/src/App.tsx`) fills the inspector's metadata only from a stream frame's
  `state`. `RunsService.stream` writes `{ node }` frames and a terminal `{ node, error }`
  frame and never sets `state`, so `RunInspector` (`apps/console/src/components/RunInspector.tsx`)
  stays at "No run data yet". The id the console shows is the one its form generated,
  `crypto.randomUUID()` in `RunForm`. `PgNeo4jMemoryInspector.inspectRun`
  (`packages/memory-core/src/inspect/run-inspector.ts`) keys on the run id, not the session.

The remaining costs are real but small. They are listed under Design, "What changes for
each reader".

## Why it matters

A client-chosen key with no ownership check is OWASP API Security Top 10 2023's first item,
API1:2023 Broken Object Level Authorization, and CWE-639, Authorization Bypass Through
User-Controlled Key. In this repository the object is a conversation and the memory
distilled from it. A write to that object is a turn in another agent's prompt, which is
OWASP ASI06, Memory & Context Poisoning. HIPAA §164.312(a)(1) asks that access be limited
to those granted it. ADR 0003 keeps real health data out of the repository, but the
prior-authorization vertical is built to show what a payer deployment would need. P5-A
made the principal the unit of ownership on one surface and left another surface that
ignores it. A reviewer who reads `contextSessionId` and then `RunRequestSchema` will find
that in a few minutes. Closing it makes "every conversation belongs to the principal that
started it" true of the whole service, not of one route.

## Scope

- A pure function that maps the authenticated principal and the session id the client
  sent to the session id the graph runs in, for `POST /runs` and `POST /runs/stream`.
- The controller applies it to both routes. The response still carries the id the client
  sent.
- A namespace for `/runs` separate from A2A's, so the two surfaces never share a session.
- Tests at the unit, service and integration tiers, including the reverse of the
  measurement in Problem.
- An ADR that extends ADR 0014 and closes its first residual. It narrows one sentence of
  ADR 0007 and supersedes neither (Design, "Records this PRD updates").
- CTL-ACC-04, added as `planned` under this PRD by this draft. The implementation moves it
  to `implemented`. It also edits CTL-ACC-02's note, STATUS row 33 and the README.

### Non-goals

Each of these is named in ADR 0014 or P5-A as unowned, and this PRD leaves it that way.

- **Console user login.** The console's nginx holds one service credential
  (`apps/console/nginx.conf.template`), so every console user is the principal `console`
  and shares one session namespace. After this PRD, two console users are kept apart only
  by the random id `RunForm` generates, which is the case today. **No PRD owns this**
  (ADR 0014).
- **TLS.** CTL-ACC-03 is `not-applicable` because nothing here is deployed. **No PRD owns
  this.**
- **OAuth 2.0 client credentials, OpenID Connect, mTLS.** The principal stays the name an
  opaque bearer token maps to. A JWT's `sub` could replace it later without changing this
  design. **No PRD owns this.**
- **A2A tasks that outlive the process.** P5-A's "What shipped" left this with no owner.
  **No PRD owns this.**
- **Isolation in open mode.** With `SERVICE_CREDENTIALS` unset every caller is `anonymous`
  (`OPEN_PRINCIPAL`, `apps/agent-service/src/auth/credentials.ts`). The scope then
  separates no one, as ADR 0014 says. Open question 1 asks whether open mode derives at
  all.
- **Who asked, in the run record.** `run_records` has no principal column
  (`RunRecordOpenSchema`, `packages/memory-core/src/audit/run-record.ts`), on either
  surface. Adding one would change the object `digestRun`
  (`apps/agent-service/src/ledger/run-digest.ts`) hashes, so it needs `RUN_DIGEST_VERSION`
  2 and a verifier for both versions. Open question 2 weighs it. **No PRD owns this** unless
  review moves it here.
- **Per-principal fact identity.** `semantic_facts` is keyed on `content_hash` alone, and
  the first writer's `session_id` stays on the row (`PgPgvectorWriter.upsertFact`,
  `packages/memory-core/src/semantic/pgvector/pgvector.writer.ts`). After this PRD, `b`
  cannot read `a`'s session. But if `b` extracts a fact first, `a`'s later extraction of
  the same text lands on `b`'s row, and `a`'s retrieval no longer finds it. That is a loss
  of recall, and it discloses nothing. P4-B's open question 2 decided not to take it.
  **No PRD owns this.**
- **Serializing concurrent runs in one `/runs` session.** The A2A executor queues runs per
  session (`KeyedQueue`, `run-executor.ts`). `/runs` does not, and two concurrent requests
  in one session race on turn indices. That is within one principal, and it predates this
  PRD. **No PRD owns this.**
- **Server-minted session ids, or a route that lists a caller's sessions.** Neither is
  needed to close the hole, and both change the contract. **No PRD owns this.**

## Design

### The rule

```ts
// apps/agent-service/src/auth/session-scope.ts
export const RUNS_SESSION_NAMESPACE = '<a fresh v4 UUID, fixed at implementation>';

/** The session a `/runs` request runs in: the client's id, inside the caller's namespace. */
export function runsSessionId(principal: string, sessionId: string): string {
  return uuidV5(RUNS_SESSION_NAMESPACE, `${principal}\n${sessionId}`);
}
```

`uuidV5` moves from `apps/agent-service/src/a2a/session-id.ts` to this module, and
`session-id.ts` imports it. `A2A_SESSION_NAMESPACE` and `contextSessionId` do not change.
Changing them would orphan every A2A session, as their doc comment says. The newline
argument also carries over unchanged. `parseCredentials` admits only
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}` as a principal, so no principal contains a newline and
no two `(principal, sessionId)` pairs give the same name.

**Why derive, and not look up.** This is the mechanism ADR 0014 accepted for A2A: no table,
no write and no lookup on the request path. An ownership table would be a new write from
app code, which `CLAUDE.md` routes through `memory-core`. Every run would then pay a read
before `ingress`. It would also need a policy for the first caller to name an id, which is
the "first write wins" problem again, moved to a new table.

**Why the derived id stops being a secret that matters.** After this PRD, no route takes
a storage session id from a caller. `/runs` derives one, and A2A derives one. A caller who
computes another principal's derived id, as `b` did in Problem, gains nothing: `/runs`
derives again, under `b`'s principal, into a session nobody else can reach. The isolation
rests on that, and not on the namespace being private.

**Why a separate namespace.** If `/runs` used `A2A_SESSION_NAMESPACE` and the same name
format, a principal's A2A context `X` and its `/runs` session `X` would be one session.
`/runs` writes the history the client sends, turn 0 onward, and A2A rebuilds history and
requires its turn indices to be contiguous (`rebuildHistory`). Mixing the two would produce
the collision P5-A's history design exists to prevent. A separate namespace makes that
impossible by construction.

### Where it applies

In `RunsController` and nowhere below it:

```ts
@Post()
@HttpCode(200)
async createRun(@Body(runRequest) body: RunRequest, @Req() req: Request, ...): Promise<RunResponse> {
  const scoped = { ...body, sessionId: runsSessionId(callerOf(req), body.sessionId) };
  const response = await this.runsService.execute({ body: scoped, correlationId });
  return { ...response, sessionId: body.sessionId };
}
```

`streamRun` does the same before `RunsService.stream`. Its frames carry no session id, so
there is nothing to map back. `callerOf(req)` is `principalOf(req) ?? OPEN_PRINCIPAL`,
which is the rule `mountA2a`'s `userBuilder` already applies (`apps/agent-service/src/a2a/mount.ts`).
In open mode the middleware attaches `OPEN_PRINCIPAL`. In a test that never mounted the
middleware it attaches nothing, and the request is `anonymous` in both cases.

`principalOf` and not `authenticatedPrincipal`. The latter returns `undefined` in open
mode, because it answers a different question: whether an action can be bound to a
person. That is the question the review and appeal controllers ask.

`RunsService` does not change. That keeps `executeTraced`, and so the evaluation harness,
on the id its task names (Problem). The controller is the HTTP surface, as `RunExecutor`
is the A2A surface, and each one derives its own session before calling the shared loop.

**The response carries the client's id.** A client continues a conversation by sending
the same `sessionId` with the history again. If the response returned the derived id,
a client that copied it into its next request would be derived a second time, into a
different session. So the contract does not change. `RunResponseSchema`'s `sessionId`
stays the id the client sent, and `runs.e2e-spec.ts`'s "returns 200 with a valid
RunResponse" goes on asserting the client's id without an edit.

### What changes for each reader

| Reader                                                    | Before                                | After                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `episodes`, `semantic_facts`, graph edges and `:Fact`s    | written under the client's id         | written under `runsSessionId(principal, id)`                                                                                                                                                                                    |
| Checkpoints (`thread_id = runId`)                         | state holds the client's id           | state holds the derived id; `thread_id` unchanged                                                                                                                                                                               |
| `run_records.session_id` and `request` (P3-B)             | the client's id and the body as sent  | the derived id, and the body with the derived id in it. That is what A2A's records already hold: `RunExecutor` builds the body `RunsService.run` records. `audit:replay` re-executes `record.request`, so replay is unaffected. |
| Ledger `run.recorded` (P3-C)                              | digest of the record                  | same function over the new record; `RUN_DIGEST_VERSION` unchanged, because the record's shape does not change                                                                                                                   |
| `gen_ai.conversation.id` and `session_id` span attributes | client's id                           | derived id, as on A2A runs. No new attribute, so `ALLOWED_SPAN_ATTRIBUTES` (`packages/telemetry/src/genai.ts`) does not change.                                                                                                 |
| `RunResponse.sessionId`                                   | client's id                           | client's id                                                                                                                                                                                                                     |
| Console                                                   | sends `RunForm`'s id; reads none back | no change                                                                                                                                                                                                                       |
| Evaluation harness, cassettes, `baselines/replay.json`    | in process, on the task's id          | no change                                                                                                                                                                                                                       |
| Data written before this lands                            | under raw ids                         | unreachable through `/runs` and not deleted. Nothing here is deployed. The compose stack's volumes are throwaway.                                                                                                               |
| An operator tracing a client's session                    | the client's id is the storage key    | from the response's `runId`: `run_records.session_id` for that run is the storage key                                                                                                                                           |

One existing assertion changes. `audit-replay.integration.test.ts`'s
"leaves one run_records row holding the body sent and every decision in order" compares
`run_records.request` with the body it posted. It will compare with that body under the
derived id, and the title will say so. That is the one sentence of ADR 0007 this PRD
narrows: its header holds "the body as received" by the run loop, after the surface has
scoped it. A2A has recorded a synthesized body since P5-A, and no record said so.

### Records this PRD updates

- **An ADR**, numbered when written (0017 is free at drafting; check every branch first, as
  `docs/adr/README.md` says). Its title: "Every surface derives its session from the
  caller". It **extends ADR 0014**. ADR 0014's decision ("Ownership is per principal on the
  A2A surface") gains `/runs`, and the first residual is closed. **It narrows ADR 0007's
  "the body as received"**, as ADR 0008 narrows ADR 0003 and ADR 0015 narrows ADR 0010.
  Neither ADR 0014 nor ADR 0007 is superseded, because neither decision is reversed. It
  records the rejected alternatives: an ownership table, server-minted ids, sharing A2A's
  namespace, returning the derived id, and scoping inside `RunsService`.
- **`governance/controls.yaml`.** This draft adds CTL-ACC-04, "A `/runs` caller reads and
  writes only its own principal's sessions", as `planned` under P5-D, mapped to HIPAA
  §164.312(a)(1), ASI03 and ASI06. The implementation moves it to `implemented` with the
  test anchors below. It also edits CTL-ACC-02's note, which this draft corrects to say
  that `/runs` reaches A2A sessions too.
- **`docs/STATUS.md` row 33** drops "per-session authorization on `POST /runs`" from
  **Not built** and cites the new tests.
- **`README.md`**, the authenticated `/runs` example: one sentence saying the session is
  the caller's, so the same `sessionId` from another token is another conversation.

## Acceptance criteria

Every criterion is on model `stub`, with no `generateContent` call. Each one names its
memory axis. The integration tier is `yarn turbo test:integration`, against Postgres and
Neo4j, as `e2e.yml`'s `e2e` job runs it with `REQUIRE_INTEGRATION_ENV` set.

- [ ] **Unit.** `runsSessionId` returns a UUID, is stable for one principal and id, differs
      for two principals with one id, and differs from `contextSessionId` for the same
      principal and the same string. `contextSessionId`'s existing tests in
      `session-id.test.ts` pass unedited, including "matches the RFC 9562 example".
- [ ] **Service tier, memory stub.** With `SERVICE_CREDENTIALS` set to two principals,
      `POST /runs` from each with one `sessionId` returns `200`, and each response's
      `sessionId` equals the one sent. `runs.e2e-spec.ts` passes with no edit to the
      file.
- [ ] **Integration, memory live: the reverse of Problem's measurement.** Principal `a`
      sends an A2A message in context `C`. Principal `b` sends `POST /runs` with
      `sessionId = contextSessionId('a', C)` and three messages. `b`'s `retrievedContext` is
      empty, and `a`'s second message in `C` reports `messageCount: 3`. No `episodes` row
      under `contextSessionId('a', C)` carries `b`'s run id.
- [ ] **Integration, memory live: two principals, one id.** `a` and `b` each send
      `POST /runs` with the same `sessionId`. The `run_records` rows of the two runs have
      different `session_id` values, equal to `runsSessionId('a', id)` and
      `runsSessionId('b', id)`. `b`'s `retrievedContext` holds no fact whose `episodeId` is
      `a`'s run.
- [ ] **Integration, memory live: continuity within a principal.** `a` sends two
      `POST /runs` with one `sessionId`, the second carrying the first's messages plus a new
      user turn. The second run's `retrievedContext` includes the fact the first run
      wrote, and `episodes` for `runsSessionId('a', id)` holds turns `0..3` with no gap.
- [ ] **Integration, memory live: audit replay.** `audit-replay.integration.test.ts`
      passes. Its one changed assertion compares `run_records.request` with the posted body
      under the derived `sessionId`, and every other test in the file is unedited.
      `ledger.integration.test.ts` passes unedited, and `RUN_DIGEST_VERSION` is still `1`.
- [ ] **Replay axis, memory live.** `EVAL_CASSETTE_MODE=replay yarn eval` reports the gate
      verdict `match` against the committed `baselines/replay.json`. The pull request
      changes no file under `packages/eval-harness/datasets/`.
- [ ] **Compose tier, memory live.** `scripts/a2a-compose-check.mjs` still passes all its
      lines, and the Playwright test "a submitted run streams through to done on the
      authenticated stack" passes in `e2e.yml`'s `browser-e2e`.
- [ ] The ADR exists, is indexed in `docs/adr/README.md`, and states that it extends
      ADR 0014 and narrows ADR 0007 without superseding either. CTL-ACC-04 is
      `implemented` with the integration tests above as its anchors, and CTL-ACC-02's note
      no longer names `/runs` as uncovered. STATUS row 33's **Not built** no longer lists
      `/runs`.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Risks and open questions

1. **Does open mode derive?** In open mode every caller is `anonymous`, so deriving
   separates no one. It does change the storage key for every quickstart call: the
   README's `550e8400-…` becomes a different id in `episodes`, so a reader checking the
   quickstart with `psql` has to go through `run_records`. Passing the id through
   unchanged in open mode would keep that, and would also leave the P3-B assertion alone
   in open mode. The cost is that the rule then depends on the mode, and a database used
   first in open mode and then in enforced mode would hold raw ids an open-mode caller
   could still name. A2A derives in both modes. **Recommendation: derive in both modes.**
   Then the rule reads the same as A2A's, and "no route takes a storage id from a caller"
   has no exception.
   **Decided at review, 2026-10-12: derive in both modes.** The README's quickstart says
   that its id is the client's, not the storage key, in the same change.
2. **The scoped body in the record, or the body as sent plus the principal?** The design
   records what the run loop received, which is A2A's behaviour today, and changes no
   schema. The alternative keeps ADR 0007's sentence literally true. It adds a `principal`
   column to `run_records`, and replay derives the session again from the record. That
   costs a `memory-core` migration, a `RunRecordOpenSchema` field and `RUN_DIGEST_VERSION`
   2, with `ledger:verify` reading both versions. It is about `M` on its own, and it would
   answer "who asked" for both surfaces, which nothing records today.
   **Recommendation: record the scoped body here, and leave "who asked" as the residual
   named in Non-goals.** If review wants the principal recorded, it should be its own PRD,
   because it concerns the record on both surfaces and not `/runs`.
   **Decided at review, 2026-10-12: the scoped body.** "Who asked" stays an unowned
   residual; it is a question about the record on both surfaces, not about `/runs`.
3. **Extend ADR 0014, or supersede it?** The decision is unchanged and gains one surface.
   Superseding would mark the authentication decision itself as replaced, which it is not.
   **Recommendation: a new record that extends 0014 and narrows 0007**, following the
   0008/0003 and 0015/0010 precedent.
   **Decided at review, 2026-10-12: extend and narrow**, numbered when written.
4. **CTL-ACC-02's note is corrected in this draft, not at implementation.** The control
   stays `implemented`, because its title is about what an A2A caller reaches through
   A2A, and the probe did not falsify that. Its note said `/runs` "lets an authenticated
   caller name any session" and did not say that this includes another principal's A2A
   sessions. That is the finding this PRD exists for. The note now says it.
   **Recommendation: keep the correction.** If review disagrees, it reverts with no other
   effect.
   **Decided at review, 2026-10-12: keep it.**
5. **The premise could be wrong if a client depends on the storage id equalling its own.**
   None in the repository does. The console reads no id back, the harness runs in
   process, and the gateway proxies without parsing. A client outside the repository that
   queries Postgres by its own `sessionId` would break. Nothing here is deployed, so there
   is no such client.
6. **Size.** `S`. The derivation already runs on the A2A path and passes its unit and
   compose tests. The new code is a function, a controller change and tests. The
   integration criteria need live stores and use the existing integration job. What could
   make it larger is open question 2, if review moves the principal into the record.

## References

- OWASP API Security Top 10 2023, API1:2023 Broken Object Level Authorization —
  <https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/>.
- MITRE CWE-639, Authorization Bypass Through User-Controlled Key —
  <https://cwe.mitre.org/data/definitions/639.html>.
- OWASP Top 10 for Agentic Applications 2026, ASI03 and ASI06, as catalogued in
  `governance/controls.yaml`.
- 45 CFR §164.312(a)(1), as catalogued in `governance/controls.yaml`.
- RFC 9562 §5.5, name-based UUIDs.
- ADR 0014 (the decision this extends), ADR 0007 (the record sentence this narrows),
  ADR 0008 and ADR 0015 (the precedent for narrowing without superseding).
- `docs/prd/P5-A-a2a-server.md`, "Tasks, contexts, runs and sessions" and its Non-goals;
  `docs/prd/P4-B-memory-poisoning-red-team.md`, Non-goals, "Authentication".
