---
id: P3-E
title: Clinician review queue, `$inquire` and the decision clock
tier: 3
status: shipped
size: M
depends_on: [P3-A, P3-D]
blocks: [P3-F]
issue: 98
superseded_by: null
controls: [CTL-HUM-02]
---

# P3-E · Clinician review queue, `$inquire` and the decision clock

## Problem

P3-D returns a pended `ClaimResponse` and stops. Its non-goals hand this PRD everything that
happens to a referred request afterwards: "the clinician review queue, the route that calls
`attestAdverseDetermination`, `Claim/$inquire`, and the overdue detection a clock implies"
(`P3-D-payer-dataset-fhir-prior-auth.md:120-124`), appeals (`:127-128`), and the clinician
who denies an administrative case (`:129-133`). Those were P3-A's hand-offs to P3-D
(`P3-A-clinician-gate.md:127-128`, `:140-142`) before the split P3-D's review accepted
(`P3-D-...md:724-738`). P3-C's ledger names the same surface as the first producer of
`determination.attested` entries (`P3-C-decision-ledger.md:103-105`). P4-C's review decided
that "P3-E's clinician route is the first HTTP resume surface this repository needs, and it
is designed against a real pause" (`P4-C-reversible-tool-registry.md:424-426`).

None of P3-A, P3-C or P3-D is built. `packages/` holds no `determination`, `prior-auth` or
`decision-ledger` package, `apps/agent-service/src/` has no `fhir/` directory, and all three
PRDs are `accepted` (`docs/prd/README.md`, Tier 3 table). This PRD is drafted against their
designs, and every file it names under those packages is one they create.

P3-D proposed the mechanism: "the pended lifecycle through LangGraph `interrupt()` on this
PRD's checkpoint" (`P3-D-...md:733-734`). Two things in the repository bear on that proposal,
and neither is visible from P3-D.

**ADR 0001 draws the line this proposal crosses.** It chose the checkpointer over a workflow
engine because "agent runs here are measured in seconds" (`0001-...md:20-23`), and it names
the prior-authorization case as the thing on the other side of that choice: "A prior
authorization is submitted, pends for records, waits on a clinician, and may be appealed —
days to weeks, mostly spent idle, with external callbacks and durable timers"
(`0001-...md:47-52`). Its revisit trigger is "a single run starts spanning minutes with
external callbacks", and "Adding a case layer above the graph is not a revisit of this
decision — it is a new one, and it belongs in its own record" (`0001-...md:66-68`). A thread
paused in `interrupt()` for up to seven days, waiting on an HTTP callback from a clinician,
is the revisit trigger. A case table beside the graph is the new record.

**`interrupt()` on the pinned LangGraph was probed.** `main` pins `@langchain/langgraph`
0.4.10 (`yarn.lock:1524-1526`); P5-C's upgrade has not landed. A throwaway Vitest file in
`apps/agent-service/src/agent/graph/` on 2026-09-26 built `dispose → review → finalize`,
with `review` calling `interrupt()`, compiled against `MemorySaver`, and was deleted
afterwards. What it showed:

- **A pause works as documented.** `invoke` returned the state with an `__interrupt__` array
  holding the interrupt's `id` and value. `getState` reported `next: ['review']` and the
  same interrupt on `tasks[0]`. A graph rebuilt with a different closure resumed the thread
  with `new Command({ resume })`, and the resumed node ran again from its first line: a
  counter before the `interrupt()` call read 2 after one pause and one resume.
- **A second resume on a finished thread is a silent no-op.** A `Command({ resume })` invoke
  on a thread whose `next` was `[]` returned the old state, with no error and no indication
  that the new value was discarded.
- **A resume on a thread that never existed succeeds.** It returned `{ log: [] }` and wrote a
  checkpoint for the unknown thread id, which then appeared in `list({})`.
- **Two concurrent resumes both succeed.** `Promise.all` of two `Command({ resume })` calls
  on one paused thread returned two different decisions to the two callers, and the stored
  state held the second. Nothing in the saver serialises them.
- **A resume pinned to the paused `checkpoint_id` forks.** After the thread had finished, a
  resume configured with the old `checkpoint_id` re-ran `review` and `finalize`, and the
  fork became the thread's latest state.
- **With no checkpointer, the node runs up to the call and throws**
  `GraphValueError: No checkpointer set` (`dist/interrupt.js:60`). The service compiles without one on the
  unconfigured memory axis (`graph.ts:107`, `memory.module.ts:110-119`).
- **The resume value is untyped.** `interrupt<I = unknown, R = any>(value: I): R`
  (`dist/interrupt.d.ts:44`). A node that returns the resumed value into a channel passes
  P3-A's `Node` alias check whatever the value is, because it is `any`.

So a graph resume, used as the decision mechanism, needs a guard outside the graph against
all four of the silent cases, and it puts the clinician's determination into the agent's
state through an `any`. Both are designed around below rather than accepted.

There is also nothing to list. P3-D writes no record of a case apart from its checkpoint.
`PostgresSaver.list` accepts a config with no `thread_id` and a metadata containment filter
(`@langchain/langgraph-checkpoint-postgres@0.1.3`, `dist/index.js:232-257`), so a queue
could scan checkpoints. It would read every super-step of every chat run to find the
prior-authorization cases, and it would have no column for a due date to sort on.

## Why it matters

CMS-0057-F moves the clock and leaves the reviewer rule where it was. From 2026-01-01 a
Medicare Advantage plan must decide a standard prior-authorization request "7 calendar days
after receiving the request" (42 CFR § 422.568(b)(1)(ii)) and an expedited one "no later
than 72 hours after receiving the request" (§ 422.572(a)(1)). Medicaid managed care has the
same two numbers (§ 438.210(d)). When a physician asks for an expedited decision because the
standard timeframe "could seriously jeopardize the life or health of the enrollee", the plan
"must" expedite it (§ 422.570(c)). An adverse decision must be reviewed by "a physician or
other appropriate health care professional with expertise in the field of medicine … that is
appropriate for the services at issue" (§ 422.566(d)). And the regulation closes the loop on
the clock itself: "If the MA organization fails to provide … timely notice of an
organization determination … this failure itself constitutes an adverse organization
determination and may be appealed" (§ 422.568(f)). A request that sits unseen in a queue
past its deadline is, in law, a denial nobody signed.

That is why the queue is where a reviewer who knows the domain looks next, after P3-D's
intake. They will ask who the clinician is and how the denial is bound to them, whether the
software can reorder the queue on its own reading of the case, and what happens at the
deadline. SB 1120 forbids a tool to "deny, delay, or modify" care based on medical
necessity (Cal. Health & Safety Code § 1367.01(k)). P3-D's reading of "delay" holds only
while "the tool holds nothing" (`P3-D-...md:497-499`). A queue ordered by the tool's
findings would be the tool holding something. Each of the three questions is a criterion
below.

## Scope

- **A case layer above the graph, recorded in a new ADR.** A `prior_auth_cases` table,
  written through `memory-core`, holds every request P3-D's `$submit` receives, its clock,
  its status, the response issued, and the determination that closed it. The
  prior-authorization graph stays as P3-D builds it and finishes at `dispose`. No thread is
  paused or resumed.
- **`$submit` enqueues, and fails closed.** P3-D's controller writes the case row before it
  returns. A referral that cannot be enqueued is not returned as pended.
- **The clinician review surface** in `apps/agent-service/src/review/`: the queue, one case,
  and the determination route that calls `attestAdverseDetermination`.
- **The reviewer's identity is a signature.** An Ed25519 signature over P3-C's attestation
  payload, verified against a reviewer registry of public keys. The service holds no
  reviewer's private key.
- **`POST /fhir/Claim/$inquire`**, shaped after PAS 2.2.1's operation: query by example over
  the case table, returning a `Parameters` of response bundles.
- **The decision clock, completed.** `isOverdue` beside P3-D's `decisionDueBy`, a queue order
  that is a function of the clock alone, and an overdue sweep that flags and never decides.
- `docs/STATUS.md` rows, the CapabilityStatement's new operation, and the "Before real data"
  entries the case table adds.

### Non-goals

- **Pausing the prior-authorization graph with `interrupt()`.** Rejected in this draft for the
  reasons in Problem and Design. It is open question 1, because P3-D and P4-C both expected
  it. If review chooses it, **this PRD** builds it and grows to L.
- **Subscriptions.** PAS says "Implementers SHALL support subscriptions to provide the final
  response" (§spec-51), over the R4 backport's rest-hook channel only (§spec-54, §spec-56),
  with full-resource notifications (§spec-60 to §spec-62). The surface cannot claim PAS
  conformance whatever it builds, because P3-D decided at review that the repository holds no
  X12 code values (`P3-D-...md:722-723`). A rest-hook channel is outbound delivery with
  retries, a heartbeat and a receiver to test against, which is a PRD of its own. The
  CapabilityStatement declares no `Subscription` resource, so it says what is true. **No
  successor proposed.** A provider learns the final decision by `$inquire`.
- **Appeals.** A reconsideration is a second decision with its own clock and its own reviewer
  rule. The request is filed "within 60 calendar days after receipt of the written
  organization determination notice" (§ 422.582). The decision is due in 30 calendar days for
  a standard pre-service case and 72 hours for an expedited one. It must be made by "a person
  or persons who were not involved in making the organization determination", and an
  affirmed denial goes "to the independent entity" (§ 422.590). That is a second lifecycle,
  and M does not hold it. **Proposed successor: P3-F, "Reconsideration with a non-involved
  reviewer"**, not in the index until review accepts it (open question 4). This PRD stores
  the deciding `reviewerId` on the case, so P3-F's non-involvement check is one comparison.
- **Partial approval.** P3-A's `partial-approval` carries a reason and no statement of what
  was approved (`P3-A-clinician-gate.md:177-182`), so a `ClaimResponse` built from it could
  not say what the provider may deliver. None of P3-D's six strata has partial approval as
  its correct outcome (`P3-D-...md:187-194`). The route answers `422` to it. **No successor
  proposed.** Adding it means an amendment to P3-A's type first.
- **Requests for additional information and timeframe extensions.** Both plans may extend a
  deadline by up to 14 calendar days (§ 422.568(b)(2), § 422.572(b), § 438.210(d)). An
  extension is a clinician's decision with a notice requirement of its own, and it would
  make `decisionDueBy` depend on something other than receipt, which is the property P3-D's
  SB 1120 reading rests on (`P3-D-...md:494-496`). **No successor proposed.** Because
  extensions are not modelled, the sweep flags an extended case as overdue on its original
  deadline. That is the conservative error.
- **Downgrading an expedited request.** § 422.570(d) lets a plan move an enrollee's expedite
  request to the standard timeframe, counted from the original receipt. Priority here comes
  only from `Claim.priority` (`P3-D-...md:473-475`), and no route changes it. **No successor
  proposed.**
- **Notices to the enrollee.** § 422.568(d)-(e) require written notice to the enrollee with
  the specific reason and appeal rights. The `ClaimResponse` goes to the provider. Member
  correspondence is a separate channel. **No successor proposed.**
- **A reviewer user interface.** The routes return JSON. A console page is presentation over
  them. **No successor proposed.**
- **Authenticating `/fhir/*` and `/review/*` callers.** P5-A's middleware covers `/runs`,
  `/runs/stream` and `/a2a/*` by name (`P5-A-a2a-server.md:314`). **P5-A**, or whichever of
  P5-A and P3-E lands second, adds the two prefixes. The attestation signature below binds a
  determination to a reviewer with or without it.
- **Identity proofing and key custody.** That a key's holder is the licensed person named in
  the registry is outside what code can show. P3-C already puts it on the "Before real data"
  list (`P3-C-decision-ledger.md:106-110`). **P3-C**.

## Design

### Where the case lives, and the ADR it needs

The agent's work on a request is one run of seconds: P3-D's four nodes, one model call,
finished inside the `$submit` exchange (`P3-D-...md:355-361`). The case is everything after
that: a queue position, a due date, a reviewer, a determination and, later, an appeal. ADR
0001 assigns those to different layers, with the checkpointer as the seam. This PRD adds the
case layer the ADR anticipates and writes the record it asks for.

**The new ADR: "The prior-authorization case lives above the graph."** Its number is taken
when it is written, since 0007 and 0008 are reserved by P3-B and P3-D. It records:

- LangGraph owns the agent's run on a request, from `intake` to `dispose`. The run finishes.
  Its checkpoints under `thread_id = caseId` are the audit trace of what the agent read and
  found, as P3-B uses them.
- The case layer owns the queue, the clock, the overdue sweep and the determination. It is a
  table and a sweep, not a workflow engine.
- Why not `interrupt()`: the seven-day pause is ADR 0001's revisit trigger, and the four
  silent cases in Problem each need a guard outside the graph anyway. The determination would
  also enter agent state through an `any` (`dist/interrupt.d.ts:44`). A paused thread would
  span deploys and upgrades, which P5-C's cross-version check did not cover
  (`P5-C-langgraph-1x.md:287-290`), and P3-B's replay assumes a linear graph with no
  interrupts (`P3-B-audit-replay.md:120-123`).
- **Revisit when** the case needs a timer that acts. Auto-forwarding an affirmed denial to
  the independent entity (§ 422.590) and a request for information that stops the clock are
  the two in view. A durable-execution engine earns its operational cost at that point, and
  the case table is what it would replace.

### The case table

In `packages/memory-core/src/cases/`, beside `episodic/`. P3-C's test for what belongs in
`memory-core` is the database role: a table the service writes with its own role belongs
there, as P3-B's run record does (`P3-C-decision-ledger.md:133-135`). The case table is
updated in place, so it cannot go in the ledger's insert-only package.

```sql
CREATE TABLE prior_auth_cases (
  case_id            uuid PRIMARY KEY,          -- = thread_id = ClaimResponse.identifier value
  status             text NOT NULL CHECK (status IN ('approved-automated', 'pended', 'decided')),
  priority           text NOT NULL CHECK (priority IN ('expedited', 'standard')),
  received_at        timestamptz NOT NULL,
  decision_due_by    timestamptz NOT NULL,
  member_id          text NOT NULL,             -- query-by-example keys for $inquire
  insurer_id         text NOT NULL,
  provider_id        text NOT NULL,
  hcpcs              text NOT NULL,
  request            jsonb NOT NULL,            -- the request Bundle as received
  disposition        jsonb NOT NULL,            -- AgentDisposition, findings and rationale
  response           jsonb NOT NULL,            -- the response Bundle currently in force
  recommendation_seq bigint,                    -- P3-C's disposition.recommended seq, when a ledger is configured
  determination      jsonb,                     -- DeterminationRecord, set once
  reviewer_id        text,
  signature          text,
  decided_at         timestamptz,
  overdue_flagged_at timestamptz
);
CREATE INDEX prior_auth_cases_queue ON prior_auth_cases (decision_due_by, received_at, case_id)
  WHERE status = 'pended';
```

```ts
// packages/memory-core/src/cases/case.repo.ts
export interface CaseRepository {
  enqueue(row: NewCase): Promise<void>; // INSERT; a duplicate case_id throws
  get(caseId: string): Promise<CaseRow | null>;
  queue(limit: number): Promise<CaseRow[]>; // status = 'pended', ordered by the index above
  match(example: CaseExample): Promise<CaseRow[]>; // $inquire
  decide(caseId: string, decision: Decision): Promise<DecideResult>; // see "Deciding"
  flagOverdue(now: Date): Promise<string[]>; // sets overdue_flagged_at once; returns case ids
}
```

It has two implementations: `DrizzleCaseRepository` on the configured memory axis, and
`InMemoryCaseRepository` on the unconfigured one. One contract suite runs against both. The
in-memory store is volatile, and boot logs `review.cases.volatile` at `warn`. That is P5-A's
open-mode pattern (`P5-A-a2a-server.md:323-334`): an unconfigured axis runs and says so,
while a configured and unreachable one exits 1 as it does today. It keeps P3-D's stub-axis
criteria, which return `queued` with no database (`P3-D-...md:664-665`), and it lets the
service spec exercise review without Postgres. Open question 2 is the alternative.

`disposition` is parsed through `AgentDispositionSchema` on write and again on read, so a
row edited to hold a denial fails the parse the way P3-A's egress does
(`P3-A-clinician-gate.md:307-311`). `determination` is parsed through
`DeterminationRecordSchema`, P3-A's reader schema, which validates without minting
(`:262-267`).

The row stores the request and the model's rationale, which is member data on a real
deployment. It goes on the "Before real data" list with an owner, beside P3-B's items:
retention, encryption at rest, and access to the rationale.

### `$submit` enqueues, and fails closed

P3-D's controller gains one step after `dispose`. It writes the case row, `pended` for a
referral and `approved-automated` for an approval, with the response it is about to return,
and then returns it. If the write throws, `$submit` answers `503` with an `OperationOutcome`
and returns no `ClaimResponse`. A pended response for a case no queue holds would be the
tool holding a request. That is P3-B's decided split applied to this path: "a decision that
cannot be recorded is not returned" (`P3-B-audit-replay.md:368-372`).

With a ledger configured, the same step appends P3-C's `disposition.recommended` for the
case and stores its `seq` in `recommendation_seq`. P3-C wires that append from `RunsService`
(`P3-C-decision-ledger.md:93-94`), and the prior-authorization graph does not run through
`RunsService`. So whichever of P3-C and P3-E lands second adds the append to the FHIR
service.

### The review surface

`apps/agent-service/src/review/`, outside `src/agent/`, so P3-A's lint rule permits its
import of `@repo/determination/clinician` (`P3-A-clinician-gate.md:244-255`). These are
internal utilization-management routes, not FHIR resources:

```
GET  /review/cases                       200 { cases: QueueItem[] }  pended, in clock order
GET  /review/cases/:caseId               200 CaseView               the request, findings, rationale,
                                                                     and the payload to sign
POST /review/cases/:caseId/determination 200 Bundle (response shape): entry[0] ClaimResponse
     400 malformed body or empty specificReason     401 signature fails, key unknown or revoked
     403 credential not accepted for this policy    404 no such case
     409 case decided with a different determination 422 partial-approval
     503 no reviewer registry, or the case store or ledger write failed
```

`CaseView` is the one place the model's per-criterion rationale is served, which is where
P3-D said the reviewer reads it (`P3-D-...md:388-389`). It shows findings and the evidence
each cites, and no suggested outcome, as P3-A designed the referral
(`P3-A-clinician-gate.md:190-196`).

### Who the clinician is

A signature binds the determination to a key. The service verifies it and never produces
it.

```ts
// the body of POST /review/cases/:caseId/determination
{
  determination:
    | { kind: 'clinician-approval'; attestation: ClinicianAttestation }
    | { kind: 'denial'; specificReason: string; attestation: ClinicianAttestation };
  recommendationSeq: number | null;   // from CaseView; null when no ledger is configured
  reviewerKeyId: string;
  signature: string;                  // Ed25519, base64url, over the bytes below
}
// signed bytes: canonicalJson({ determination, recommendationSeq, runId: caseId })
```

The signed bytes are P3-C's, exactly (`P3-C-decision-ledger.md:260-262`), with the case id
as `runId`, so the same signature is accepted by the ledger when one is configured. The case
id inside the signed bytes stops a signature for one case being replayed onto another.
`canonicalJson` is `@repo/agent-cassette`'s (`packages/agent-cassette/src/hash.ts:16`).

**The registry.** `REVIEWER_REGISTRY` names a JSON file of
`{ reviewerKeyId, reviewerId, credential: { type, jurisdiction }, publicKey, principal? }`.
It follows the axis rule. Unset, the determination route answers `503` and the read routes
still serve. Malformed, the service exits 1 at boot naming it. With a ledger configured,
each entry is appended as P3-C's `reviewer-key.registered` if it is absent, and from then on
the ledger's registration and revocation entries are authoritative.

**The checks, in order.** The body parses. The key is in the registry and not revoked. The
signature verifies with `crypto.verify(null, bytes, publicKey, signature)` from
`node:crypto`. `attestation.reviewerId` equals the key's `reviewerId`. For a denial,
`attestation.credential.type` is in the policy's `reviewerCredentials`, a list each P3-D
policy file gains. That is § 422.566(d)'s "expertise … appropriate for the services at
issue", reduced to what code can check. When P5-A is enforcing and the registry entry names
a `principal`, the bearer's principal must equal it. Only then does the route call
`attestAdverseDetermination` for a denial.

**Why the reviewer's client signs.** The alternative is the server signing on the reviewer's
authenticated session. P3-C's threat model lists stolen service credentials and says forged
attestations "fail the signature check" (`P3-C-decision-ledger.md:316`). That row holds only
if the service cannot sign. A server-held reviewer key would let the credential P5-A issues
to the console mint denials. Tests generate keypairs in-test. `scripts/review-sign.mjs`
signs a `CaseView` payload with a local key file for the demo, and the file is gitignored.

### Deciding

```ts
// apps/agent-service/src/review/review.service.ts
async determine(caseId: string, body: DeterminationBody, principal: string): Promise<Bundle>
```

1. Verify as above. Mint the determination: `attestAdverseDetermination` for a denial,
   P3-A's unbranded `ClinicianApproval` for an approval (`P3-A-clinician-gate.md:207-208`).
   P3-A names that type in its union (`:185`) and never defines it, as it did
   `CriterionFinding` for P3-D. This PRD proposes
   `{ readonly kind: 'clinician-approval'; readonly attestation: ClinicianAttestation }`,
   and it belongs in `@repo/determination`, whichever PRD is implemented first.
2. `decide(caseId, …)`, which in Postgres is one transaction:
   `SELECT … FOR UPDATE` the row. If it is `decided` with a byte-identical signature, return
   the stored response (a retry). If it is `decided` otherwise, or `approved-automated`,
   return `409`. If it is `pended`, then with a ledger configured append
   `determination.attested` with `entry_id = UUIDv5(LEDGER_NS, caseId + "\ndetermination")`.
   A failed append rolls back and answers `503`, so the case stays pended, which is P3-C's
   decided fail-closed rule for determinations (`P3-C-decision-ledger.md:404-408`). Then
   update the row with the determination, reviewer, signature, `decided_at` and the new
   response, and commit.
3. The ledger's idempotent append (`P3-C-decision-ledger.md:279-281`) makes the derived
   `entry_id` a second guard. If the commit fails after the append, the retry finds the same
   entry and payload. A different determination for the same case throws there even if the
   row lock were bypassed. `InMemoryCaseRepository` gets the same semantics from a per-case
   mutex.

Each of the probe's silent cases maps to an answer here. An unknown case is `404`. A decided
case is `409`, or the same response on a byte-identical retry. Concurrent submissions give
one `200` and one `409`. There is no checkpoint to fork, because nothing resumes.

The response is built by a new mapping beside P3-D's:

```ts
// packages/prior-auth/src/claim-response.ts
export function toDeterminationResponse(
  claim: PasClaim,
  determination: ClinicianApproval | AdverseDetermination,
  policy: Policy,
  clock: { decidedAt: Date },
): PasClaimResponse;
```

An approval maps to `outcome: complete` with `preAuthRef` and `preAuthPeriod`. A denial maps
to `outcome: complete` with neither. It carries the clinician's `specificReason` in a
`processNote`, as CMS-0057-F requires a specific reason (§ 422.122(a)), and a fixed
template in `disposition`. Neither branch carries model text. P3-D's sentinel test is
extended to both routes.

### The clock, completed

```ts
// packages/prior-auth/src/clock.ts, beside P3-D's decisionDueBy
export function isOverdue(c: { decisionDueBy: Date }, now: Date): boolean; // now >= decisionDueBy
export type QueueKey = { caseId: string; receivedAt: Date; decisionDueBy: Date };
export function compareCases(a: QueueKey, b: QueueKey): number; // due, then received, then id
```

**The queue is ordered by the clock alone.** That is the P3-E half of P3-D's SB 1120
reading. P3-D's invariants were that the deadline depends on receipt alone and that the tool
holds nothing (`P3-D-...md:494-499`). If the queue sorted a case lower because the agent
found a criterion `not-met`, a tool's reading of medical necessity would have postponed a
clinician's attention to it. That is the "delay" the reading says the tool never causes.
`QueueKey` has no field a finding could reach. A type test pins it, the SQL index orders by
the same three columns, and a test shows two queues with identical clocks and opposite
findings sort identically.

**Overdue is flagged, never decided.** A `ReviewSweep` provider runs every
`REVIEW_SWEEP_MS` (default 60000) and calls `flagOverdue(now)`. That sets
`overdue_flagged_at` on each pended case past `decision_due_by` that has none, and emits one
`review.case.overdue` span event per case, with the case id, priority and minutes past due.
The case stays `pended` and its response stays `queued`. Auto-denial at the deadline is what
P3-A forbids. Auto-approval at the deadline is a policy some state laws adopt and CMS's does
not. § 422.568(f) already makes the lapse appealable, which is the member's remedy and not
the software's decision. The queue item and `CaseView` carry `overdue: boolean`, computed at
read time from the clock, so a case is shown as overdue even before the sweep has run.

**What the clock measures.** The determination span records `prior_auth.decided_within_ms`
(`decided_at - received_at`) and `prior_auth.on_time`. That is the time to a decision. The
regulation's clock runs to notice (§ 422.568(b)(1)), and with no subscription the surface
cannot show when a provider learned the decision. It can show when the decision was
available to `$inquire`. The STATUS row says so.

### `POST /fhir/Claim/$inquire`

PAS defines it as a "query-by-example" whose input is one inquiry `Bundle` and whose output
is "Zero-to-many Bundles, each containing a single ClaimInquiryResponse"
(`OperationDefinition-Claim-inquiry`). The inquiry `Claim`'s identifier "is used to identify
the inquiry itself and is not used in searches for previous authorizations" (specification,
Prior Authorization Inquiries). The profile requires `patient`, `provider` and `insurer`,
1..1 each, and makes `item` 0..\* (`profile-claim-inquiry`).

```
POST /fhir/Claim/$inquire     Content-Type: application/fhir+json | application/json
  200  Parameters { parameter: [{ name: "return", resource: Bundle }, …] }   zero or more
  400  OperationOutcome        body is not a Bundle, or entry[0] is not a Claim
  422  OperationOutcome        no member identifier, insurer or provider to match on
```

Matching is by example, on what P3-D's bundles carry. The patient's member identifier is
typed `MB` from `http://terminology.hl7.org/CodeSystem/v2-0203`, a THO system ADR 0008
permits. The insurer and provider are matched by identifier. When the inquiry has items, the
match narrows by each item's HCPCS `productOrService` and, for an approval, by the
`authorizationNumber` item extension against the issued `preAuthRef`. Each matching case
contributes its current `response` bundle. A pended case answers `queued` until it is
decided, and `complete` after. PAS's inquiry profiles bind `productOrService` and other item
elements to X12 value sets. So `$inquire` is "shaped after" PAS in the same sense and for the
same reason as `$submit` (`P3-D-...md:283-292`), and P3-D's validator job reports the
distance for the captured inquiry responses as it does for submissions. §spec-52 says a
payer "SHALL permit access to the prior authorization response to systems other than the
original submitter". Any caller that passes authentication may inquire, and nothing scopes
results to the submitter.

### File layout

```
packages/memory-core/src/cases/{schema,case.repo,in-memory.repo,index}.ts   + one migration
packages/memory-core/src/cases/case.repo.contract.ts     one suite, two implementations
packages/prior-auth/src/clock.ts                         isOverdue, QueueKey, compareCases
packages/prior-auth/src/clock.test-d.ts                  QueueKey pinned
packages/prior-auth/src/claim-response.ts                toDeterminationResponse
packages/prior-auth/data/policies/*.json                 + reviewerCredentials
apps/agent-service/src/fhir/                             $submit enqueues; $inquire; CapabilityStatement
apps/agent-service/src/review/{review.module,review.controller,review.service,
                               registry,signature,review.sweep}.ts
apps/agent-service/test/review.e2e-spec.ts               queue, determination, $inquire
scripts/review-sign.mjs                                  demo signer; key file gitignored
docs/adr/NNNN-the-prior-auth-case-lives-above-the-graph.md
```

No graph node is added, so no new `agent.node.*` span is needed. The routes and the sweep
each get a span from `getTracer` (`packages/telemetry/src/index.ts:1`): `review.queue`,
`review.case`, `review.determination`, `review.overdue_sweep` and `fhir.inquire`. No model
call is added, so no seam changes and no cassette is re-recorded.

## Acceptance criteria

The model axis does not apply: this PRD adds no model call, and every criterion below holds
on model `stub`. The axes that apply are the **memory** axis (Postgres, or the in-process
case store), the **ledger** axis (P3-C's `LEDGER_DATABASE_URL`) and the **auth** axis
(P5-A's `SERVICE_CREDENTIALS`). Each criterion names the ones it was checked on.

**Decision record and topology**

- [x] The new ADR exists, is indexed in `docs/adr/README.md`, cites ADR 0001's revisit
      clause, and names the revisit trigger for the case layer.
- [x] `git grep -nE 'interrupt\(|new Command\(' apps/agent-service/src` matches nothing. The
      prior-authorization graph's edges are P3-D's and end at `dispose`.

**Case store**

- [x] `case.repo.contract.ts` passes against `DrizzleCaseRepository` (memory live, Postgres
      container) and against `InMemoryCaseRepository` (memory unconfigured). It covers
      enqueue, a duplicate `case_id` rejected, queue order, match, decide, and a second
      decide conflicting.
- [x] Twenty concurrent `decide` calls with distinct determinations on one pended case yield
      exactly one success and nineteen conflicts. Memory live and memory unconfigured.
- [x] A row whose `disposition` is edited to `{ "kind": "denial", … }` makes `get` throw.
      Memory live.
- [x] Booting with memory unconfigured logs `review.cases.volatile` at `warn`. Booting with
      it configured and Postgres stopped exits 1, as today.

**`$submit` enqueues**

- [x] Each of P3-D's 24 bundles posted to `$submit` leaves one case row: `pended` for every
      `queued` response and `approved-automated` for every `complete` one. Memory
      unconfigured, and memory live for one bundle of each kind.
- [x] With a case repository that throws, `$submit` returns `503` with an `OperationOutcome`,
      and the body contains no `ClaimResponse`. Memory unconfigured, repository injected.

**Queue and clock**

- [x] `clock.test-d.ts` fails `yarn turbo typecheck` if `QueueKey` gains or loses a key, or
      if `Parameters<typeof compareCases>[0]` is not `QueueKey`.
- [x] Two sets of pended cases with identical clock fields and opposite findings, one all
      `met` and one all `not-met`, come back from `GET /review/cases` in the same order.
      Memory live and memory unconfigured.
- [x] With the `Clock` fixed, a standard case received `2026-03-01T10:00:00Z` is not overdue
      at `2026-03-08T09:59:59Z` and is overdue at `2026-03-08T10:00:00Z`. An expedited case
      is overdue at `2026-03-04T10:00:00Z`.
- [x] Two sweeps over one overdue case set `overdue_flagged_at` once and emit one
      `review.case.overdue` event. The case stays `pended`, and `$inquire` still returns
      `outcome: queued` for it. Memory live.

**Determination**

- [x] A denial signed by a registered key whose credential type the policy lists returns
      `200` and a `Bundle` whose `ClaimResponse` has `outcome: complete`, no `preAuthRef`,
      and the `specificReason` in a `processNote`. The case row is `decided` with the
      `reviewer_id` and signature. Memory live, ledger unconfigured, auth open.
- [x] A clinician approval on another case returns `outcome: complete` with a `preAuthRef`.
- [x] Each of these gets the stated status, and the case stays `pended`: no signature `400`;
      a key not in the registry `401`; a valid signature over a different case id `401`;
      `attestation.reviewerId` not the key's `401`; a credential type the policy does not
      list `403`; `partial-approval` `422`; an empty `specificReason` `400`; an unknown case
      id `404`.
- [x] A byte-identical resubmission of a decided case returns `200` with the stored body. A
      different determination on it returns `409`.
- [x] With `REVIEWER_REGISTRY` unset, the determination route returns `503` and
      `GET /review/cases` returns `200`. With it malformed, boot exits 1 naming it.
- [x] `yarn turbo lint` passes with `src/review/` importing `@repo/determination/clinician`,
      and P3-A's lint test for a path under `src/agent/` still reports one error.
- [x] The sentinel test: a rationale sentinel from a stub `assess` appears in
      `GET /review/cases/:id` and in neither the determination response nor any `$inquire`
      response.
- [ ] Ledger configured (checkable once P3-C has shipped; until then this box stays open
      with owner P3-C): a denial appends one `determination.attested` entry whose
      `entry_id` is the derived one, and `ledger:verify` exits 0. With the ledger's database
      stopped, the route returns `503` and the case stays `pended`. Memory live.
- [ ] Auth enforced (checkable once P5-A has shipped; until then open with owner P5-A): a
      valid signature from a registry entry naming principal `a`, sent with principal `b`'s
      token, returns `403`.

**`$inquire`**

- [x] An inquiry `Bundle` naming a member, insurer and provider returns a `Parameters` with
      one `return` Bundle per matching case, each with a `ClaimResponse` first. A pended
      case's is `queued`, and after a determination the same inquiry returns `complete`.
      Memory live and memory unconfigured.
- [x] Changing the inquiry `Claim.identifier` does not change the result. An inquiry
      matching no case returns a `Parameters` with no `return` parameter. A non-`Bundle`
      body returns `400` with an `OperationOutcome`.
- [x] `GET /fhir/metadata` lists `$submit` and `$inquire`, and no `Subscription` resource.
- [x] P3-D's `fhir-validate.yml` validates the captured `$inquire` responses against base R4
      with zero errors, and its PAS report lists only X12-bound elements for them. On the pull
      request's run (run 37831155950): 61 files gated with 0 errors, 5 `$inquire`
      returns reported, and 0 errors in `other`.

**Bookkeeping**

- [x] `docs/STATUS.md` has a row for the review queue and determination route, citing
      `review.e2e-spec.ts` and stating that on-time means decided, not notified.
- [ ] P3-C's "determinations and attestations in the ledger" row names P3-E, not P3-D. The
      row is P3-C's to add and does not exist yet; P3-C's criterion now names P3-E as the
      producer, so the row will. Owner **P3-C**.
- [x] `.context/conventions.md`'s "Before real data" lists the case table's request and
      rationale columns, with retention, encryption and access as owned items.
- [x] Every fixture reviewer, key and registry entry is labelled synthetic, and
      `lint-data.mjs` passes.
- [x] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## What shipped, and where it diverged

_Recorded 2026-10-08, on the branch for #98._ Every ticked criterion was verified on model
`stub` with no `generateContent` call, on memory unconfigured and on memory live against
throwaway Postgres and Neo4j containers, ledger unconfigured, auth open. The review spec,
`apps/agent-service/test/review.e2e-spec.ts`, runs both memory axes: unconfigured under
`yarn turbo test:service`, and live too under `yarn turbo test:integration`, which is what
the integration job in `e2e.yml` runs with `REQUIRE_INTEGRATION_ENV`. Run that way, the file
passed 34 of 34 across both axes. After the rebase onto P3-B, the same run passed
memory-core's suite 61 of 61 and P3-B's audit-replay suite 14 of 14, whose prior-authorization
replay now runs through a `$submit` that enqueues.

**Built as designed.** ADR 0010 records the case layer and cites ADR 0001's revisit clause.
`prior_auth_cases` is migration `0003` in `memory-core`, with `DrizzleCaseRepository` and the
volatile `InMemoryCaseRepository` held to one contract. `$submit` enqueues before it answers
and answers 503 when it cannot. `src/review/` serves the queue, one case and the determination
route; `$inquire` and the CapabilityStatement are in `src/fhir/`; `ReviewSweep` flags. No
graph node was added, and `git grep -nE 'interrupt\(|new Command\(' apps/agent-service/src`
matches nothing.

**The probe, re-run.** The Problem section's probe of `interrupt()` was on LangGraph 0.4.10.
P5-C has since moved the pin to 1.4.18, so it was run again on 2026-10-08 with the same
throwaway graph, then deleted. Every finding held: a second resume on a finished thread is
dropped silently, a resume on an unknown thread creates it, two concurrent resumes both
report success, a graph with no checkpointer throws `GraphValueError`, and the resumed value
is still typed `any`. ADR 0010 cites both runs.

**Checks the design did not state.**

- **The attestation's credential must equal the registered one**, not only its `reviewerId`
  (401). Without it, a key registered to a credential the policy does not list could sign a
  denial claiming one it does.
- **`recommendationSeq` must be the case's** (400). The body carries it because P3-C's bytes
  do; a value other than the one `CaseView` served is a client error.
- **A registry entry may carry `revokedAt`.** Revocation was to be a ledger entry, and there
  is no ledger yet, so the file holds it until P3-C does. A revoked key is 401.
- **`$submit` refuses a request it could not key** (422): a patient with no identifier typed
  `MB`, or a provider with no identifier. A case nobody can inquire about is one the payer
  could not answer for. All 24 bundles carry both.
- **A denial on a code no policy covers is 403**, because there is no credential list to match.
  An approval on such a case is issued with a `preAuthRef` and no `preAuthPeriod`.

**Other divergences.**

- **`request` and `response` are `json`, not `jsonb`.** `jsonb` reorders keys, so a retried
  determination would be answered with a body that differs in key order from the first. The
  spec compares the retry's bytes with the first response's, on both axes.
- **The table has a `reviewer_key_id` column**, which the sketch did not. An auditor cannot
  re-verify a stored signature without knowing which key made it. A CHECK constraint refuses
  a half-decided row whatever wrote it, and a second index serves `$inquire`.
- **`decide` takes a `beforeCommit` hook**, run under the lock before the update. It is where
  P3-C's `determination.attested` append goes; the contract shows a throw there leaves the
  case pended, on both stores.
- **`flagOverdue` returns the case, its priority and its deadline**, not only the id, because
  the span event carries the priority and the minutes past due.
- **The queue route re-sorts with `compareCases`.** The store already returns clock order;
  sorting again over `QueueKey` makes the route's order the clock's by type, not only by
  query.
- **The demo signer is `yarn workspace @repo/agent-service review:sign`**, not
  `scripts/review-sign.mjs`. It must sign exactly the bytes `signature.ts` verifies, and a
  root script may import only root devDependencies. Its key file goes under a gitignored
  `.review-keys/`.
- **Case keys are `system|value` tokens**, so the same value in two identifier systems never
  matches. The CapabilityStatement names PAS's `Claim-inquiry` canonical, because base R4
  defines no inquiry operation.
- **Spans.** `@repo/telemetry` gained `withServiceSpan`, which opens `review.queue`,
  `review.case`, `review.determination`, `review.overdue_sweep` and `fhir.inquire`, each held
  to `ALLOWED_SPAN_ATTRIBUTES`; `memory-core` opens `memory.cases.*` around each query.
- **A `Date` from the service spec failed `z.date()`.** Jest's ESM VM context is another realm,
  so the first `$submit` through the real module answered 503. The case schemas check the
  `Date` tag instead, and the conventions now say so.
- **The review spec is the second command of `agent-service`'s `test:integration`**, after
  P3-B's Vitest suite. P3-B already orders that task after `memory-core`'s, and the case
  contract empties `prior_auth_cases` before each test, so the same ordering keeps it from
  running under the review spec's live axis.
- **`$submit` writes two records, in a fixed order, and fails closed on either.** P3-B's run
  record opens before the graph runs, takes the `assess.criteria` decision, and closes; only
  then is the case row written. A failed record leaves no case, so the queue never holds a
  request whose answer was not sent. A failed enqueue leaves a closed record with no case
  beside it, an audit of agent work whose answer was never returned, which a resubmission
  does not duplicate in the queue. The other order would leave a pended case for a response
  never sent. `prior-auth.service.test.ts` asserts the order, that no record failure
  (open, append or close) leaves a case, and that an enqueue failure leaves the record
  closed as `success`. Both failures answer 503 with an `OperationOutcome`, with different
  diagnostics.
- **CTL-HUM-02** is new and `implemented`: a determination only over a verified signature, by
  a listed credential, once per case. CTL-HUM-01's note no longer says the route is to come.
- **The migration is `0003`.** P3-B's run record landed first and took `0002`. Against a
  throwaway Postgres, a fresh database applied all four and a second run applied none, and a
  database migrated with `main`'s three, holding a run record, advanced to `0003` with the
  record intact.
- **P3-C and P3-D were amended in this change.** P3-C named P3-D as the reviewer surface and
  the determinations row's owner; both are P3-E's since P3-D's review split. P3-D said its
  checkpoint was what P3-E resumes, and that a pended case lived only in the response; neither
  is true now.

**The walkthrough, 2026-10-08.** The built service, booted with no model key and no database,
logged `review.cases.volatile` at level 40 and loaded a one-key registry written by the
signer's `keygen`. A `$submit` of `pa-e0601-one-missing` answered `queued`; the queue held
it; the signer's `sign` signed a denial over its `CaseView`; the determination answered 200
with the specific reason in the note; and `$inquire` returned it `complete`. Booted with a
registry missing a field, it exited 1 with an error that begins `REVIEWER_REGISTRY names`
and names the field, `0.reviewerId`. Booted with memory configured and the Postgres container
stopped, it exited 1 with `connect ECONNREFUSED`.

**The validator, on the pull request** (`fhir-validate.yml`, job `validate`, run 37831155950). It gated
61 files with 0 errors and reported 5 `$inquire` return bundles against PAS's inquiry
response bundle. The `other` row was empty, and the `queued` outcome class held 54 errors,
the `$submit` responses' and the pended returns' together. That agrees with the local run.

**The validator, locally.** The service specs were run with `FHIR_CAPTURE_DIR`, and
`scripts/fhir-validate.mjs` with the pinned 6.10.4 jar in an `eclipse-temurin:17-jre`
container. The gate covered 61 files, the 24 bundles and 37 captures including four `$inquire`
`Parameters` and the five bundles they returned, with 0 errors. The PAS report, now also holding each
returned bundle to `profile-pas-inquiry-response-bundle`, had 0 errors in `other`; the five
returns added six errors, all in the `queued` outcome class, two for each pended return, and
the two decided returns conform outright.

**Open criteria, and who owns them.** The ledger half (P3-C) and the auth half (P5-A) stay
open, as review decided, and so does P3-C's row naming P3-E. P3-C adds the
`determination.attested` append in `beforeCommit` and the `disposition.recommended` append at
`$submit`, since P3-E landed first. P5-A adds `/fhir/*` and `/review/*` to its middleware and
passes the bearer's principal to `ReviewService.determine`, which already compares it with a
registry entry's `principal` when both are present.

**Hand-off to P3-F.** Appeals stay out, as Non-goals says. What P3-F inherits: a decided case
row carries `reviewer_id`, so the non-involvement rule of § 422.590 is one comparison, and
`decided_at`, from which § 422.582's 60-day filing window counts; the registry, the signed
payload and the locked `decide`, which a reconsideration reuses with a second determination;
and the sweep, which flags a 30-day or 72-hour reconsideration clock the same way. Forwarding
an affirmed denial to the independent entity is a timer that acts, which is ADR 0010's revisit
trigger, so P3-F decides whether the case table is still enough.

**What the docs should have said.** Four things had to be worked out here. A `Date` made in a
service spec is not a `Date` to a package's Zod schema. Two workspaces' integration tasks share
one database and ran at once. A root script cannot reach workspace code, so a tool that must
agree with it byte for byte lives in the workspace. And `.context/architecture.md` described no
FHIR surface at all. The conventions and the architecture now cover all four. One is left: the
STATUS resolver treats only `*.test.ts` and `*.spec.ts` names as test files, so the shared
`case.repo.contract.ts` cannot be cited by test title, and row 28 cites the two `decide`
methods instead.

## Risks and open questions

**Open questions, decided at review 2026-09-26.**

1. **Case layer or graph resume.** This draft keeps the graph linear and puts the case in a
   table, for the reasons in Problem. The alternative is P3-D's proposal. A `review` node
   after `dispose` calls `interrupt()`, and the route resumes the thread with
   `Command({ resume })`. It would still need the case table, because the queue and the
   overdue sweep need a due-date column and the four silent cases need a lock outside the
   graph. On top of this design it adds a node typed to accept an `any` and an ADR that
   revisits 0001 rather than adding to it. It also adds a paused-thread check across the
   P5-C upgrade and a P3-B replay that handles a two-invocation thread. That is L. Choosing
   this draft changes two accepted documents: P3-D's "a successor can resume it"
   (`P3-D-...md:122-123`) and P4-C's decision that this route is the first HTTP resume
   surface (`P4-C-...md:424-426`). P4-C's resume endpoint returns to unowned. What does
   generalize to P4-C's approval gate is the reviewer registry, the signed approval and the
   locked decide. **Recommendation: the case layer.** _Decided: the case layer._ The probe
   found five silent or unsafe resume behaviours and an `any` where P3-A's type check
   should be, and ADR 0001 names exactly this case as its revisit trigger. P3-D and P4-C
   are amended in the same change.
2. **The unconfigured memory axis.** This draft uses a volatile in-process store with a
   `warn`. The alternative is to answer `503` to any referral when memory is unconfigured.
   That changes P3-D's accepted criterion that every bundle returns `queued` on the stub
   axis (`P3-D-...md:664-665`), and it takes review out of the no-database service spec.
   _Decided: the volatile store with a `warn`_, which is the repository's axis rule: an
   unconfigured axis runs, a configured and unreachable one exits.
3. **Dependency edges.** This draft depends on P3-A and P3-D only. The ledger and
   authentication criteria are written to stay open, with owners, until P3-C and P5-A ship.
   The index already decided the ledger is not an edge (`docs/prd/README.md`, Sequencing).
   If review wants the two conditional criteria closed at merge, P3-C and P5-A become
   `depends_on` edges, and P3-E moves behind P3-B through P3-C. _Decided: as drafted._ The
   two criteria stay open with P3-C and P5-A named as owners, and P3-E may ship without
   them only if both are named in its close-out.
4. **Appeals as P3-F.** The proposed successor adds a reconsideration lifecycle: filing
   window, 30-day and 72-hour clocks, the non-involved-reviewer check and the forward to the
   independent entity. Accept it into the index, or record appeals as unowned. _Decided:
   P3-F enters the index as a draft._ Whether it is built is decided when P3-E ships.

**Risks.**

- **Sized M against three unbuilt predecessors.** Nothing this PRD extends has run: P3-D's
  controller, `@repo/determination` and P3-D's policy files are all designs. Estimate: one
  and a half days for the case table and its contract suite, one and a half for the review
  routes and signature verification, one for `$inquire`, half a day for the clock and sweep,
  and one for the e2e spec, STATUS and the ADR. That is five and a half days, at the top of
  M. The likeliest growth is P3-D's controller turning out to need restructuring to enqueue
  before responding. Under open question 1's alternative the size is L.
- **The premise could be wrong if a reviewer reads ADR 0001 differently.** "A single run
  starts spanning minutes" could be read as agent computation, not wall-clock pause. Then a
  paused thread does not trigger the revisit, and the case layer is a choice rather than an
  obligation. The Problem section's probe findings stand either way. They are the
  engineering argument, and the ADR reading is the governance one.
- **A signature is not a person.** The registry maps a key to a `reviewerId` and a credential
  type. Nothing here proves the holder holds that licence, or that the licence is "current
  and unrestricted" (§ 422.566(d)). That is P3-C's key-custody item. The
  `reviewerCredentials` check is a type match, not a licence check.
- **On-time is measured at decision, not notice.** Without subscriptions, a decision made on
  day six and first inquired on day nine looks on time here and was not on time for the
  provider. The STATUS row states the gap rather than implying otherwise.
- **The flagged-overdue case is still the payer's problem.** § 422.568(f) turns a missed
  deadline into an appealable adverse determination. The system records when it knew
  (`overdue_flagged_at`) and does nothing else. A deployment might want escalation paging.
  That is operational, and this PRD does not claim it.
- **P3-D's evidence has drifted in one place.** It cites the global pipe at `main.ts:60`
  (`P3-D-...md:39-40`, `:349`). On `main` the file is 45 lines and the call is at
  `main.ts:25`, where P5-A cites it (`P5-A-a2a-server.md:56`, `:207`). The fix P3-D describes is
  unchanged. The line number is wrong.
- **The regulatory reading is a portfolio's, not counsel's.** The SB 1120 extension above
  adds one invariant to P3-D's reading and is stated so that a reviewer can check the
  invariant even if they reject the reading.

## References

Every external source below was read on 2026-09-26.

- HL7 Da Vinci PAS IG 2.2.1, <https://hl7.org/fhir/us/davinci-pas/2.2.1/en/>:
  `specification.html` (§spec-42, §spec-51, §spec-52, §spec-54 to §spec-62, and Prior
  Authorization Inquiries), `OperationDefinition-Claim-inquiry.html`,
  `StructureDefinition-profile-claim-inquiry.html`,
  `StructureDefinition-profile-claimresponse.html`
- HL7 FHIR Subscriptions R5 Backport IG, referenced by PAS §spec-54,
  <https://hl7.org/fhir/uv/subscriptions-backport/>
- 42 CFR § 422.566(d), § 422.568(b), (d), (e), (f) (as amended through 90 FR 15910,
  2025-04-15), § 422.570, § 422.572 (through 90 FR 15911), § 422.582 (through 89 FR 30827),
  § 422.590, § 438.210(b)(3), (c), (d) (through 89 FR 8980), at
  <https://www.law.cornell.edu/cfr/text/42/>
- CMS Interoperability and Prior Authorization Final Rule, CMS-0057-F, 89 FR 8758
  (2024-02-08), <https://www.govinfo.gov/content/pkg/FR-2024-02-08/pdf/2024-00895.pdf>
- California SB 1120 (Stats. 2024, ch. 879), Health & Safety Code § 1367.01(k)
- RFC 8032, Edwards-Curve Digital Signature Algorithm (Ed25519); Node.js `crypto.sign` and
  `crypto.verify` with a `null` algorithm for Ed25519
- LangGraph JS 0.4.10: `node_modules/@langchain/langgraph/dist/interrupt.d.ts:44`,
  `dist/interrupt.js:60`, `dist/constants.d.ts:247`; `@langchain/langgraph-checkpoint-postgres`
  0.1.3, `dist/index.js:232-257`, `:336`
- `docs/adr/0001-langgraph-over-a-durable-execution-engine.md`,
  `docs/prd/P3-A-clinician-gate.md`, `docs/prd/P3-B-audit-replay.md`,
  `docs/prd/P3-C-decision-ledger.md`, `docs/prd/P3-D-payer-dataset-fhir-prior-auth.md`,
  `docs/prd/P4-C-reversible-tool-registry.md`, `docs/prd/P5-A-a2a-server.md`,
  `docs/prd/P5-C-langgraph-1x.md`
