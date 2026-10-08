---
id: P3-F
title: 'Appeals: reconsideration lifecycle for adverse determinations'
tier: 3
status: draft
size: M
depends_on: [P3-A, P3-E]
blocks: []
issue: null
superseded_by: null
controls: [CTL-HUM-03]
---

# P3-F · Appeals: reconsideration lifecycle for adverse determinations

## Problem

P3-E ends at a signed denial. Its non-goals name what comes next and hand it here: "A
reconsideration is a second decision with its own clock and its own reviewer rule … That is
a second lifecycle, and M does not hold it" (`P3-E-clinician-review-queue.md:147-155`). Its
close-out lists what this PRD inherits: "a decided case row carries `reviewer_id`, so the
non-involvement rule of § 422.590 is one comparison, and `decided_at`, from which
§ 422.582's 60-day filing window counts; the registry, the signed payload and the locked
`decide`, which a reconsideration reuses with a second determination; and the sweep"
(`:727-733`). Review recorded the decision to index this PRD as a draft (`:777-780`).

What exists, verified on 2026-10-08 by running `apps/agent-service/test/review.e2e-spec.ts`
on memory unconfigured, model `stub` (18 of 18 passed):

- **A decided case keeps who decided it, and cannot be half-written.** `prior_auth_cases`
  carries `determination`, `reviewer_id`, `reviewer_key_id`, `signature` and `decided_at`
  (`packages/memory-core/migrations/0003_prior_auth_cases.sql:22-26`), and a CHECK
  constraint makes them all set or all null, and set exactly when `status = 'decided'`
  (`:33-48`).
- **`response` is the response in force.** `DecisionSchema` documents it as "The response
  bundle now in force: what `$inquire` returns from here on"
  (`packages/memory-core/src/cases/case.repo.ts:109`), and `$inquire` returns each matching
  row's `response` as stored (`apps/agent-service/src/fhir/inquiry.service.ts:59-69`).
- **Nothing happens to a denial after it is issued.** `CaseStatusSchema` is
  `approved-automated | pended | decided` (`case.repo.ts:16`), and `decide` answers
  `conflict` to any second decision on a decided case unless its signature is
  byte-identical (`classifyDecision`, `case.repo.ts:214-221`). There is no route, table or
  status for a request to reconsider, and no clock for one.
- **The reviewer check is equality with the key's registration, and nothing else.**
  `ReviewService.determine` refuses an attestation whose `reviewerId` or credential differs
  from the key's (`apps/agent-service/src/review/review.service.ts:300-308`) and, for a
  denial, a credential type the policy does not list (`:319-328`). It cannot compare the
  reviewer with anyone else, because there is no earlier reviewer on a pended case.

**ADR 0010 names this PRD's central mechanism as its revisit trigger.** "Revisit when the
case needs a timer that acts … Two are in view: forwarding an affirmed denial to the
independent review entity (§ 422.590, P3-F's territory), and a request for information that
stops the clock" (`docs/adr/0010-the-prior-auth-case-lives-above-the-graph.md:87-91`).
P3-E's sweep "flags, never decides" (`apps/agent-service/src/review/review.sweep.ts:26-40`).
Reading § 422.590 against that sentence separates two forwards the ADR treats as one. An
affirmed denial is forwarded by the physician who affirms it, inside the request that
affirms it, and needs no timer. A reconsideration that is not decided in time is forwarded
because the deadline passed, and nothing but a timer can do that. The second one is the
trigger, and Design answers it.

**PAS has no appeal transaction.** HL7 resolved a PAS ballot comment by agreeing to "add
language clarifying that this specification does not cover the process of appeals as it is
not handled by the X12 278 transaction. Providers should consult the payer in question to
determine the appropriate appeals mechanism" (FHIR-24326, "Not Persuasive with
Modification"). The PAS 2.2.1 narrative pages fetched on 2026-10-08 (`index`,
`specification`, `usecases`, `background`, `additionalinfo`, `conformance`,
`conformancedetails`, `epaWorkflow`, `metrics`, `privacy`, `regulations`,
`Requirements-fromNarrative`, `changelog`) use the word "appeal" once, inside a quoted HIPAA
regulation on `regulations.html`. Base R4 has no appeal resource. So any FHIR surface for
filing an appeal here would be a profile this repository invents.

## Why it matters

The appeal is where a utilization-management system is held to account for the denials it
produced, and the rule a reviewer who knows the domain checks first is who reconsiders.
Medicare Advantage puts it in one sentence: "A person or persons who were not involved in
making the organization determination must conduct the reconsideration" (42 CFR
§ 422.590(h)(1)). When the denial was for lack of medical necessity, the reconsidered
determination "must be made by a physician with expertise in the field of medicine that is
appropriate for the services at issue" (§ 422.590(h)(2)), where the initial review allowed
"a physician or other appropriate health care professional" (§ 422.566(d)). And the plan
cannot have the last word: when it "affirms, in whole or in part, its adverse organization
determination, the issues that remain in dispute must be reviewed and resolved by an
independent, outside entity that contracts with CMS" (§ 422.592(a)). P3-A made a denial
impossible to construct without a clinician's attestation; this PRD makes a reconsideration
impossible to construct by the clinician who denied, and makes "the plan affirmed" and "the
plan ran out of time" both end with the case on its way out of the plan. NIST AI RMF's
MANAGE 4.1 names "appeal and override" among the mechanisms a deployed system needs; this is
that mechanism, for the one adverse outcome the repository can produce.

### The regime, and why only one

The dataset's plans are Medicare Advantage. `payer.json` names them "Quillmark Senior
Advantage (synthetic)" and "Quillmark Senior Advantage Plus (synthetic)", each with
`regime: "CMS-0057-F"` (`packages/prior-auth/data/payer.json:12-22`), which `PayerSchema`
holds to that literal (`packages/prior-auth/src/policy.ts:88`). P3-D chose them because
"P3-D's timeframes bind Medicare Advantage and exclude exchange plans"
(`P3-D-payer-dataset-fhir-prior-auth.md:793-795`), and modelled the plans "as impacted
payers under the Medicare Advantage timeframes" (`:481-483`). The clock cites Part 422 alone
(`packages/prior-auth/src/clock.ts:1-8`). So this PRD implements Part 422, Subpart M,
standard and expedited reconsiderations of pre-service requests for an item or service, and
nothing else:

| Rule                   | Medicare Advantage (chosen)                                                                                                                               | Medicaid managed care (not built)                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Filing window          | 60 calendar days after receipt of the written notice; receipt presumed 5 days after its date "unless there is evidence to the contrary" (§ 422.582(b)(1)) | 60 calendar days "from the date on the adverse benefit determination notice" (§ 438.402(c)(2)(ii)) |
| Standard deadline      | 30 calendar days from receipt of the request (§ 422.590(a))                                                                                               | no longer than 30 calendar days (§ 438.408(b)(2))                                                  |
| Expedited deadline     | 72 hours after receiving the request (§ 422.590(e)(1))                                                                                                    | no longer than 72 hours (§ 438.408(b)(3))                                                          |
| Who reconsiders        | not involved in the organization determination (§ 422.590(h)(1)); a physician for medical necessity (§ 422.590(h)(2))                                     | neither involved "nor a subordinate of any such individual" (§ 438.406(b)(2)(i))                   |
| After an upheld denial | the plan sends the case file to the independent entity (§ 422.590(a)(2), § 422.592(a))                                                                    | the enrollee may request a State fair hearing (§ 438.408(f)); one plan level only (§ 438.402(b))   |
| Missed deadline        | "constitutes an affirmation", and the plan must forward the file (§ 422.590(d)); expedited, within 24 hours of expiry (§ 422.590(g))                      | the enrollee "is deemed to have exhausted" the plan's process (§ 438.408(c)(3))                    |

Three reasons, in order. The data says Medicare Advantage, and a second regime would need a
second plan type in a dataset that has none. The forward to the independent entity is
something the plan does, so it is something the software can record; Medicaid's next step is
the enrollee's. And Medicare Advantage's reviewer rule is about involvement in a decision,
which the case row records, while Medicaid's adds subordination, which needs an
organisation chart this repository does not have. The dataset models no group or individual
market plan, so 29 CFR 2560.503-1 and 45 CFR 147.136 are not read here. The plans are not
applicable integrated plans, so the integrated appeal rules of §§ 422.629–422.634 do not
apply either (§ 422.566(a)).

The filing window is sometimes quoted as 65 days. The regulation says 60 days after
receipt, with receipt presumed 5 days after the notice's date (§ 422.582(b)(1)). The two
agree only when there is no evidence of a later receipt, and the design keeps them apart.

## Scope

- **A reconsideration lifecycle above P3-E's case layer.** A `prior_auth_appeals` table in
  `memory-core`, written through an `AppealRepository` with Drizzle and in-memory
  implementations held to one contract, and one migration.
- **Filing.** `POST /review/appeals` records a request for reconsideration of a denied case,
  with who filed it, how, whether it was expedited, its filing deadline and its own clock.
- **The non-involved reviewer, enforced three times.** A branded `Reconsideration` whose one
  constructor refuses the initial reviewer; the route's check; and a foreign key plus a
  CHECK constraint in Postgres that hold whatever writes the row.
- **Reconsidering.** A signed reversal, which issues an approval as the case's response in
  force, or a signed affirmation, which forwards the case to the independent entity in the
  same transaction. Reconsideration is restricted to physician credential types.
- **Dismissal.** A signed dismissal for the reasons § 422.582(f) lists that the data can
  carry.
- **The forward as a recorded event.** No external system. The forward stores its reason,
  its time and a digest of the case file, and the case file is served by a route.
- **The lapse forwards.** P3-E's sweep gains one step: a reconsideration past its deadline
  is forwarded as deemed affirmed (§ 422.590(d), (g)). That is a timer that acts, and the
  ADR it needs is part of this PRD.
- **Ledger entries** for filing, reconsideration, dismissal and forward, appended under
  P3-C's fail-closed rule, if P3-C has shipped (see Design).
- `docs/STATUS.md` row, `CTL-HUM-03`, `.context/architecture.md`'s route list, and the
  "Before real data" entries the appeal table adds.

### Non-goals

- **Appealing a lapsed initial decision.** § 422.568(f) makes a missed initial deadline "an
  adverse organization determination" that "may be appealed". P3-E's sweep flags such a
  case and leaves it pended. Accepting an appeal on it would put one case in two lifecycles
  at once: P3-E's queue could still decide it while this PRD reconsidered it. Filing on a
  case that is not `decided` with a denial answers `422`. **No successor proposed**; open
  question 1.
- **Extensions.** § 422.590(f) lets a plan extend a reconsideration by up to 14 calendar
  days, with written notice. As in P3-E, an extension is a decision with a notice of its own,
  and it would make the deadline depend on something other than receipt. The sweep forwards
  on the original deadline, which sends a case to independent review sooner than an
  extended plan would. **No successor proposed.**
- **Denying an expedite request.** § 422.584(c)(2)(i) leaves an enrollee's expedite request
  to the plan's judgement and § 422.584(d) says what follows a refusal. Here, a request that
  asks for expedited review is expedited, which is what § 422.584(c)(2)(ii) requires when a
  physician makes or supports it and the shorter clock otherwise. No route downgrades it,
  as P3-E's non-goal decided for initial requests. **No successor proposed.**
- **The independent entity's side.** Recording its decision, effectuating its reversal ("the
  MA organization must authorize the service under dispute within 72 hours from the date it
  receives notice reversing", § 422.618(b)(1)), its review of a dismissal (§ 422.590(i)),
  and its remand (§ 422.592(i)). `forwarded` is the end of the plan's process here. **No
  successor proposed.**
- **Vacating a dismissal** (§ 422.582(h)) and **re-reconsideration after a remand.** A
  dismissed appeal does not block a new filing (see the partial unique index), so an
  enrollee is not locked out. **No successor proposed.**
- **Payment requests and Part B drugs.** Their deadlines are 60 days (§ 422.590(b)) and
  7 days (§ 422.590(c)). All four policies are durable medical equipment items, so neither
  arises. **No successor proposed**; Risks says what would break if a drug policy were added.
- **Notices to the enrollee and the parties.** § 422.582(g) (dismissal notice) and
  § 422.590(e)(3) (written confirmation) are member correspondence, which P3-E also left
  out. **No successor proposed.**
- **Running the agent on appeal evidence.** The reconsidering physician reads the agent's
  original findings, the initial denial and the filer's evidence. A second `assess` run
  would add a model call, a cassette and P3-D's SB 1120 questions to a decision that
  belongs to a person. **No successor proposed.**
- **Inclusion proofs for the independent entity.** P3-C names "a party who must check one
  determination — a member's appeal — without being shown the rest of the log" as the
  trigger for a Merkle tree (`P3-C-decision-ledger.md:338-342`). The forward here is a
  record, not a delivery, so no outside party verifies anything. **P3-C's proposed
  successor**, which it says "would be a new PRD", unindexed.
- **Authenticating `/review/appeals/*` callers.** P5-A's middleware already covers
  `/review/*`, amended at P3-E's review (`P5-A-a2a-server.md:315-316`), so the new routes
  need no new prefix. **P5-A**.
- **Identity proofing.** That two `reviewerId`s are two people is the registry's claim, not
  something code can show. **P3-C**, as for P3-E.

## Design

### The lifecycle

```
                    POST /review/appeals
decided denial ─────────────────────────▶ filed
                                            │
          signed reversal ◀─────────────────┼─────────────────▶ signed affirmation
               │                            │                         │ same transaction
               ▼                            │                         ▼
           reversed                         │                    forwarded (affirmed)
  (case response in force                   │
   becomes the approval)                    ├── now ≥ due, sweep or any write ──▶ forwarded (deadline-lapsed)
                                            │
                                            └── signed dismissal ──▶ dismissed
```

`reversed`, `forwarded` and `dismissed` are terminal. There is no `affirmed` state, because
§ 422.590(a)(2) and (e)(5) make the forward the consequence of the affirmation and nothing
should be able to hold one without the other. A row in `filed` past its deadline is lapsed
whether or not the sweep has reached it: every read computes it, and every write on it
forwards it first.

### The clocks

```ts
// packages/prior-auth/src/appeal-clock.ts, beside clock.ts
export const STANDARD_RECONSIDERATION_HOURS = 30 * 24; // § 422.590(a)(1)-(2)
export const EXPEDITED_RECONSIDERATION_HOURS = 72; //     § 422.590(e)(1)
export function reconsiderationDueBy(receivedAt: Date, priority: Priority): Date;
export function isLapsed(a: { readonly reconsiderationDueBy: Date }, now: Date): boolean;

export const FILING_DAYS = 60; //              § 422.582(b)
export const PRESUMED_NOTICE_DELAY_DAYS = 5; // § 422.582(b)(1)
export function filingDeadline(input: {
  readonly determinationDate: Date; // the case's decided_at
  readonly noticeReceivedAt?: Date; // evidence of a later receipt, from the filer
}): Date;
```

**The deadline counts from the plan's receipt of the request and nothing else.** That is
P3-D's first SB 1120 invariant (`P3-D-...md:499-501`) applied to the second clock, and a type
test holds `reconsiderationDueBy`'s parameters to exactly those two. Thirty days is 720
hours, the earliest instant any reading of "calendar days" allows, as P3-D counted seven
(`:484-485`).

**The filing deadline errs the other way, towards the filer.** It is the end of the UTC
calendar day that is 65 days after the determination date, or 60 days after
`noticeReceivedAt` when the filer gives a later one. The rule counts from the written
notice, and P3-E sends none (its non-goals, `P3-E-...md:172-174`); `decided_at` is when the
denial became available to `$inquire`, which is the earliest the notice could have been
dated. An early deadline would make a timely filing look late. A filing is never refused for
being late, because § 422.582(c)(2) lets a party file after the window and ask for good
cause in the same request. It is recorded with `timely: false` and decided by a person:
dismissed as untimely, or reconsidered with `goodCauseFound: true` in the signed body. A
late filing still gets its full reconsideration clock from receipt.

**The appeal queue is ordered by its clock alone**, through P3-E's `compareCases` over a
`QueueKey` whose `decisionDueBy` is the reconsideration deadline. P3-E's reason holds here
too: a queue sorted by anything the agent found would be the tool postponing a clinician's
attention (`packages/prior-auth/src/clock.ts:44-53`).

### Who files

```ts
// the body of POST /review/appeals
{
  caseId: string;
  filer: {
    role: 'enrollee' | 'representative' | 'physician';
    name: string;                                   // synthetic in every fixture
    identifier?: { system: string; value: string };
  };
  channel: 'written' | 'oral';                      // § 422.584(c)(1): oral requests documented in writing
  expedite: { requested: boolean; physicianSupport: boolean };
  enrolleeNotified?: true;                          // required when role is 'physician' and not expedited
  noticeReceivedAt?: string;                        // § 422.582(b)(1)'s "evidence to the contrary"
  statement: string;
  evidence?: Bundle;                                // § 422.586's opportunity to submit evidence
}
```

The roles are § 422.578's: a party (here the enrollee or their representative, § 422.574(a))
or "a physician who is providing treatment to an enrollee", who for a standard pre-service
reconsideration must act "upon providing notice to the enrollee". The other parties of
§ 422.574 (an assignee, an estate, another provider with an appealable interest) are not
roles, because a pre-service request in this dataset has none. The route is staff intake,
under `/review/`, because a request can arrive orally (§ 422.584(c)(1)) and a member portal
is not in scope. Nothing verifies that a physician filer treats the enrollee or that a
representative was appointed; the row records what was asserted.

`422` for a case that is not `decided` with a `denial`: an automated approval, a clinician
approval and a pended case have nothing a reconsideration can reverse. `409` when the case
already has an appeal that is not dismissed. `404` for an unknown case.

### The non-involved reviewer

The comparison is between `reviewerId`s, not keys. A reviewer with two registered keys is one
person to § 422.590(h)(1), and comparing keys would let the second key reconsider the first
key's denial. Comparing `reviewerId`s is exactly as strong as the registry's mapping from key
to person, which is P3-C's identity-proofing item.

**In the type system**, the way P3-A gates a denial:

```ts
// packages/determination/src/determination.ts
declare const reconsidered: unique symbol; // never exported, as P3-A's brand

export const ReconsiderationRecordSchema = z
  .object({
    kind: z.enum(['reversal', 'affirmation']),
    /** The written explanation § 422.590(a)(2) requires, and the reason a reversal gives. */
    explanation: z.string().trim().min(1),
    attestation: ClinicianAttestationSchema,
    /** Who made the determination under reconsideration. */
    initialReviewerId: z.string().min(1),
  })
  .strict()
  .refine((r) => r.attestation.reviewerId !== r.initialReviewerId, {
    message: 'a reconsideration is made by someone not involved in the determination',
  });
export interface Reconsideration extends ReconsiderationRecord {
  readonly [reconsidered]: true;
}

// packages/determination/src/clinician.ts, beside attestAdverseDetermination
export function attestReconsideration(
  initial: AdverseDeterminationRecord, // the stored denial, not a bare id
  input: { kind: 'reversal' | 'affirmation'; explanation: string },
  attestation: ClinicianAttestation,
): Reconsideration; // throws InvolvedReviewerError when attestation.reviewerId === initial.attestation.reviewerId
```

The constructor takes the initial denial itself rather than a reviewer id, so the caller
cannot pass the wrong one by accident; the reader schema refuses a stored record that
violates the rule, so a row edited afterwards fails its read; and `AppealRepository.reconsider`
takes a `Reconsideration`, so an object literal does not compile. `determination.test-d.ts`
gains the type tests. `./clinician` is already barred from the graph by P3-A's lint rule.

**In the route**, before anything is written, `403` with a body that says the reviewer made
the determination under reconsideration.

**In Postgres**, whatever writes the row. Probed on 2026-10-08 against
`pgvector/pgvector:pg16` (PostgreSQL 16.15) with migration `0003` applied and the DDL below:
an appeal naming the case's true reviewer inserted; one naming a different reviewer, and one
on a pended case, failed `prior_auth_appeals_initial`; setting the appeal's reviewer to the
initial one failed `prior_auth_appeals_not_involved`; another reviewer updated; and
rewriting the case's `reviewer_id` under an appeal failed the foreign key. The container was
removed.

### The table

```sql
-- packages/memory-core/migrations/0004_prior_auth_appeals.sql (the next number when written)
ALTER TABLE prior_auth_cases
  ADD CONSTRAINT prior_auth_cases_case_reviewer UNIQUE (case_id, reviewer_id);  -- the FK's target

CREATE TABLE prior_auth_appeals (
  appeal_id               uuid PRIMARY KEY,
  case_id                 uuid NOT NULL,
  initial_reviewer_id     text NOT NULL,
  status                  text NOT NULL,     -- filed | reversed | forwarded | dismissed
  priority                text NOT NULL,     -- expedited | standard
  filer                   jsonb NOT NULL,    -- role, name, identifier, channel, expedite, enrolleeNotified
  received_at             timestamptz NOT NULL,
  filing_deadline         timestamptz NOT NULL,
  timely                  boolean NOT NULL,
  reconsideration_due_by  timestamptz NOT NULL,
  request                 json NOT NULL,     -- statement and evidence, as received
  reconsideration         jsonb,             -- ReconsiderationRecord
  reviewer_id             text,
  reviewer_key_id         text,
  signature               text,
  decided_at              timestamptz,
  dismissal_reason        text,              -- not-a-proper-party | invalid-request | untimely | withdrawn
  forward_reason          text,              -- affirmed | deadline-lapsed
  forwarded_at            timestamptz,
  case_file_digest        text,              -- sha256 of the canonical case file, set at forward
  CONSTRAINT prior_auth_appeals_initial FOREIGN KEY (case_id, initial_reviewer_id)
    REFERENCES prior_auth_cases (case_id, reviewer_id),
  CONSTRAINT prior_auth_appeals_not_involved CHECK (reviewer_id IS DISTINCT FROM initial_reviewer_id),
  CONSTRAINT prior_auth_appeals_clock CHECK (reconsideration_due_by > received_at)
  -- plus CHECKs on each enum, and a state CHECK in the style of prior_auth_cases_decided:
  -- each terminal status carries exactly its own columns, and `filed` carries none of them.
);
CREATE UNIQUE INDEX prior_auth_appeals_one_open ON prior_auth_appeals (case_id)
  WHERE status <> 'dismissed';
CREATE INDEX prior_auth_appeals_queue ON prior_auth_appeals
  (reconsideration_due_by, received_at, appeal_id) WHERE status = 'filed';
```

`request` is `json` for P3-E's reason: a retried action returns bytes identical to the first
answer (`P3-E-...md:646-648`). The foreign key cannot check that the case was a denial
rather than a clinician approval, so the repository checks it on `file` and the contract
covers it. `InMemoryAppealRepository` is constructed over the `InMemoryCaseRepository` it
references and shares its per-case mutex, so the in-memory axis has the same semantics: the
contract suite runs each constraint above against both.

```ts
// packages/memory-core/src/cases/appeal.repo.ts
export interface AppealRepository {
  file(row: NewAppeal): Promise<FileResult>; // 'filed' | 'not-appealable' | 'already-open' | 'not-found'
  get(appealId: string): Promise<AppealRow | null>;
  queue(limit: number): Promise<AppealRow[]>; // filed, clock order
  reconsider(
    appealId: string,
    r: Reconsideration,
    signed: SignedAction,
    options?: { response?: Document; beforeCommit?: Hook },
  ): Promise<ActionResult>;
  dismiss(
    appealId: string,
    d: Dismissal,
    signed: SignedAction,
    options?: { beforeCommit?: Hook },
  ): Promise<ActionResult>;
  forwardLapsed(now: Date, caseFileOf: (row) => Document): Promise<ForwardedAppeal[]>;
}
```

`reconsider` is one transaction: lock the appeal row, then the case row. If the appeal is
lapsed, forward it as `deadline-lapsed` and return `lapsed`. If it is terminal with a
byte-identical signature, return it unchanged; otherwise `conflict`. If it is `filed`, run
`beforeCommit`, and write: for a reversal, the appeal becomes `reversed` and the case's
`response` becomes the reversal's; for an affirmation, the appeal becomes `forwarded` with
`forward_reason = 'affirmed'`, `forwarded_at` and the case-file digest. The case's
`determination`, `reviewer_id` and `signature` are never touched, so P3-E's record of the
initial denial stays as it was signed.

### The signed bytes

```ts
// apps/agent-service/src/review/signature.ts, beside signedBytes
export function appealSignedBytes(input: {
  action: 'reconsideration' | 'dismissal';
  appealId: string;
  caseId: string;
  body: unknown; // the reconsideration with goodCauseFound, or the dismissal
}): Buffer; // canonicalJson({ action, appealId, runId: caseId, body })
```

The keys differ from P3-E's `{ determination, recommendationSeq, runId }`
(`signature.ts:18-31`), so a signature over an initial determination never verifies as a
reconsideration and the reverse. The appeal id inside the bytes stops a signature being
moved to another appeal on the same case after a dismissal. The checks are P3-E's in its
order (`review.service.ts:229-253`): registry configured or `503`, body parses or `400`,
appeal exists or `404`, key active or `401`, signature verifies or `401`, attestation
matches the key's reviewer and credential or `401`, principal matches when P5-A supplies one
or `403`. Then the new ones:

- the reviewer is not the initial reviewer, or `403`;
- for a reconsideration, the credential type is in the policy's
  `reconsiderationCredentials`, or `403`;
- an untimely appeal is reconsidered only with `goodCauseFound: true`, or `400`; and an
  `untimely` dismissal of a timely appeal is `400`.

**`reconsiderationCredentials` is a new policy field, and only physicians may be in it.**
`PolicySchema` holds it to `^synthetic-[a-z0-9-]*physician$`. That is § 422.590(h)(2)'s
"physician", which is narrower than § 422.566(d)'s "physician or other appropriate health
care professional" for the initial review. The determination records no basis for a denial
(P3-A types every adverse outcome alike, `packages/determination/src/determination.ts:94-110`),
so the physician rule is applied to every reconsideration, including one of a denial a
reviewer might call administrative. The four policies' current `reviewerCredentials` are all
physician types (`packages/prior-auth/data/policies/*.json`), so each gets the same list.

Dismissals take any active registered key and the same non-involvement check. The text of
§ 422.590(h) binds the reconsideration, not a dismissal; applying it to both is one rule
instead of two, and a dismissal is adverse to the filer.

### Forwarding

**What is forwarded is a record, not a delivery.** No independent-entity system is
contacted. `forwarded` means the plan's process for that appeal ended with the case file
built, its digest stored and the time recorded. The STATUS row says so in those words.

**The case file** is `canonicalJson` of the case's request, its agent findings, the initial
denial, the appeal's filing and evidence, the reconsideration if there was one, and the
written explanation: the reconsidering physician's `explanation` for an affirmation, or a
fixed sentence citing § 422.590(d) or (g) for a lapse. `case_file_digest` is its SHA-256
when forwarded, and `GET /review/appeals/:id/case-file` rebuilds it and returns both. The
agent's findings are in it because a reconsideration reviews "the evidence and findings upon
which it was based" (§ 422.580). That makes the case file the second place the model's
rationale is served, after P3-E's `CaseView`, and P3-D's sentinel test is extended to say so
and to keep it out of every FHIR response.

**An affirmation forwards in its own transaction.** § 422.590(e)(5) allows "24 hours of its
affirmation" for an expedited one and § 422.590(a)(2) the 30-day deadline for a standard
one; zero satisfies both.

**A lapse forwards from the sweep, and from any write that finds it.** P3-E's `ReviewSweep`
gains a second call per period, `appeals.forwardLapsed(now, …)`, after `flagOverdue`. It
moves each `filed` appeal at or past its deadline to `forwarded` with
`forward_reason = 'deadline-lapsed'` in one conditional `UPDATE … WHERE status = 'filed'`,
and emits one `review.appeal.forwarded` span event per appeal on `review.overdue_sweep`.
§ 422.590(g) allows 24 hours after an expedited deadline; the sweep's default period is
60 seconds (`review.sweep.ts:12-13`). A reconsideration that arrives after the deadline but
before the sweep is answered `409`, with the appeal forwarded by that request. That follows
the text of § 422.590(d), "this failure constitutes an affirmation", and open question 2
asks whether a late reversal should be accepted instead.

### Why the case table still holds, and the ADR

ADR 0010 says a durable-execution engine "earns its operational cost" when the case needs "a
timer that acts, or a wait that must survive a crash mid-step" (`0010-...md:87-93`). The
lapse is a timer that acts. It does not need an engine, for a reason the ADR could not state
before the action existed: the action is one conditional `UPDATE` in the database the timer
reads. A crash leaves the row `filed` or `forwarded` and nothing between, a second sweep
finds nothing to do, and there is no external call to retry or compensate. What would need
the engine is the forward becoming a delivery: a submission to an outside system that can
fail after the plan has committed to it.

**The new ADR, "A timer whose action is one local transaction stays in the case layer"**,
records that, refines ADR 0010's revisit trigger to "a timer or a wait whose action crosses a
process boundary", and cites this PRD's lapse as the first acting timer and why it
qualifies. ADR 0010 is accepted and is not edited (`docs/adr/README.md`'s rule); the new
record narrows its trigger the way ADR 0008 narrows ADR 0003 without superseding it. Its
number is taken when it is written: 0011 is held by an unmerged branch
(`feat/p4-b-memory-poisoning`, commit `c3619ef`) and 0012 is P2-D's.

### The FHIR surface

There is no FHIR operation for filing or deciding an appeal, because PAS defines none and
says so (Problem), and an invented profile on a surface P3-D states is "shaped after" PAS
(`P3-D-...md:265-292`) would be presented as a standard it is not. The CapabilityStatement
does not change.

What a provider sees changes in one place. A reversal writes the case's `response`, so
`$inquire` returns the approval with no change to `InquiryService`: `outcome: complete`, a
`preAuthRef`, a `preAuthPeriod` from the policy, and a fixed `disposition`, "Approved on
reconsideration." It is built by a new `toReconsideredResponse` beside P3-E's
`toDeterminationResponse` (`packages/prior-auth/src/claim-response.ts:195`) and carries no
model text. An affirmation leaves the denial in force, as it is in law until the independent
entity rules. P3-D's validator job covers the reversal's captured response.

### The routes

```
POST /review/appeals                                  201 AppealView
     400 malformed   404 no such case   409 an open appeal exists   422 not a decided denial
GET  /review/appeals                                  200 { appeals: AppealQueueItem[] }   filed, clock order
GET  /review/appeals/:appealId                        200 AppealView: the case view, the initial denial,
                                                          the filing, timely, lapsed, what to sign
POST /review/appeals/:appealId/reconsideration        200 Bundle (the case's response in force)
     400 401 403 404   409 decided otherwise, or lapsed and forwarded   503 store or ledger failed
POST /review/appeals/:appealId/dismissal              200 AppealView   400 401 403 404 409 503
GET  /review/appeals/:appealId/case-file              200 { caseFile, digest, forwardedDigest | null }
```

`AppealQueueItem` carries the appeal id, case id, priority, receipt, deadline, `lapsed`,
`timely` and the HCPCS code, and no finding. Every route gets a span from `withServiceSpan`:
`review.appeal.file`, `review.appeal.queue`, `review.appeal.view`,
`review.appeal.reconsideration`, `review.appeal.dismissal` and `review.appeal.case_file`,
each held to `ALLOWED_SPAN_ATTRIBUTES`. No graph node and no model call are added, so no
`agent.node.*` span, seam or cassette changes.

### The ledger

P3-C's union has five kinds (`P3-C-decision-ledger.md:82-85`, `:220-256`) and is being
implemented now. This PRD adds four, appended in `beforeCommit` so a failed append leaves
the appeal as it was and answers `503`, which is P3-C's rule for determinations
(`:276-277`):

```ts
  | { kind: 'appeal.filed'; appealId: string; caseId: string; determinationSeq: number;
      priority: 'expedited' | 'standard'; timely: boolean; filerRole: string }
  | { kind: 'reconsideration.attested'; appealId: string; caseId: string; determinationSeq: number;
      reconsideration: ReconsiderationRecord; reviewerKeyId: string; signature: string }
  | { kind: 'appeal.dismissed'; appealId: string; reason: string; reviewerKeyId: string; signature: string }
  | { kind: 'appeal.forwarded'; appealId: string; reason: 'affirmed' | 'deadline-lapsed';
      caseFileDigest: string }
```

`determinationSeq` names the case's `determination.attested` entry, and the verifier checks
non-involvement from the chain alone: the reviewer registered to the reconsideration's key
differs from the reviewer registered to the key on the cited determination. That is the
fourth enforcement of the rule, and the only one that survives an edit to both tables.
Whichever of P3-C and P3-F lands second adds the kinds, the `beforeCommit` appends and the
verifier check. If P3-C lands first, that is about a day inside this PRD and an amendment
note in P3-C. If this PRD lands first, the ledger criteria stay open with owner P3-C, as
P3-E's did.

### Other changes

- `PayerSchema`'s plans gain `lineOfBusiness: z.literal('medicare-advantage')`. The regime is
  a rule's name today, and the line of business, which decides which appeal rules apply, is
  only inferable from plan names and P3-D's prose.
- `apps/agent-service`'s `test:integration` script names spec files one by one
  (`apps/agent-service/package.json:16`), so `test/appeal.e2e-spec.ts` is added to it, or it
  runs on neither axis in CI's integration job.

### File layout

```
packages/determination/src/{determination,clinician}.ts      Reconsideration, attestReconsideration
packages/determination/src/determination.test-d.ts            + a literal is not a Reconsideration
packages/memory-core/migrations/0004_prior_auth_appeals.sql   + meta journal entry, hand-written as 0003
packages/memory-core/src/cases/{schema,appeal.repo,in-memory.appeal.repo}.ts
packages/memory-core/src/cases/appeal.repo.contract.ts        one suite, two stores
packages/prior-auth/src/appeal-clock.ts, appeal-clock.test-d.ts
packages/prior-auth/src/claim-response.ts                     + toReconsideredResponse
packages/prior-auth/src/policy.ts, data/policies/*.json       + reconsiderationCredentials; payer lineOfBusiness
apps/agent-service/src/review/{appeal.controller,appeal.service}.ts, signature.ts, review.sweep.ts
apps/agent-service/test/appeal.e2e-spec.ts
docs/adr/NNNN-a-timer-whose-action-is-one-local-transaction.md
governance/controls.yaml                                      CTL-HUM-03 → implemented at ship
```

## Acceptance criteria

The model axis does not apply: no model call is added, and every criterion holds on model
`stub`. The axes are **memory** (Postgres, or the in-process store), **ledger** (P3-C's
`LEDGER_DATABASE_URL`) and **auth** (P5-A's `SERVICE_CREDENTIALS`). Each criterion names the
ones it is checked on.

**Decision record**

- [ ] The new ADR exists, is indexed in `docs/adr/README.md`, cites ADR 0010's revisit
      clause, and states the refined trigger.
- [ ] `git grep -nE 'interrupt\(|new Command\(' apps/agent-service/src` still matches
      nothing.

**Store and invariant**

- [ ] `appeal.repo.contract.ts` passes against the Drizzle store (memory live) and the
      in-memory store (memory unconfigured), covering: file on a denial; `not-appealable` on
      an automated approval, a clinician approval and a pended case; `already-open` for a
      second open appeal; a new filing accepted after a dismissal; queue order; reverse;
      affirm; dismiss; a byte-identical retry `unchanged`; a different action `conflict`.
- [ ] On memory live, an `INSERT` naming an `initial_reviewer_id` other than the case's fails
      `prior_auth_appeals_initial`; an `UPDATE` setting `reviewer_id` to the initial reviewer
      fails `prior_auth_appeals_not_involved`; and an `UPDATE` of the case's `reviewer_id`
      under an appeal fails the foreign key. Each by raw SQL, not through the repository.
- [ ] `determination.test-d.ts` fails `yarn turbo typecheck` if an object literal satisfies
      `Reconsideration`, or if `AppealRepository['reconsider']` accepts a
      `ReconsiderationRecord`.
- [ ] `attestReconsideration` throws `InvolvedReviewerError` when the attestation's
      `reviewerId` is the initial denial's, and `ReconsiderationRecordSchema` rejects a stored
      record whose two reviewer ids are equal. Unit, no axis.
- [ ] Twenty concurrent reconsiderations with distinct signatures on one filed appeal yield
      one success and nineteen conflicts. Memory live and memory unconfigured.

**Clocks**

- [ ] With the clock fixed, a standard appeal received `2026-03-01T10:00:00Z` is not lapsed at
      `2026-03-31T09:59:59Z` and is lapsed at `2026-03-31T10:00:00Z`; an expedited one is
      lapsed at `2026-03-04T10:00:00Z`.
- [ ] A denial decided `2026-03-01T15:00:00Z` has a filing deadline of `2026-05-05T23:59:59.999Z`
      (65 days, end of the UTC day); with `noticeReceivedAt` `2026-03-20`, `2026-05-19T23:59:59.999Z`;
      with a `noticeReceivedAt` earlier than the presumption, the presumed deadline.
- [ ] `appeal-clock.test-d.ts` fails typecheck if `reconsiderationDueBy` gains a parameter.
- [ ] Two appeal sets with identical clocks and opposite findings come back from
      `GET /review/appeals` in the same order. Memory unconfigured.

**Routes** (memory live and memory unconfigured, ledger unconfigured, auth open)

- [ ] A filing on a denied case returns `201`, and the appeal is `filed` with the computed
      deadlines. A filing past the window returns `201` with `timely: false`.
- [ ] A physician's standard filing without `enrolleeNotified: true` returns `400`. A filing
      with `expedite.requested: true` is `expedited`.
- [ ] A reversal signed by a physician key other than the initial reviewer's returns `200`; the
      case's `response` is the reversal's; `$inquire` then returns `outcome: complete` with a
      `preAuthRef` for that case; and the case's `determination`, `reviewer_id` and
      `signature` are unchanged.
- [ ] An affirmation returns `200` with the denial still in force, and the appeal is
      `forwarded` with `forward_reason = 'affirmed'`, `forwarded_at` equal to `decided_at`,
      and a `case_file_digest` equal to the digest `GET …/case-file` recomputes.
- [ ] Each gets the stated status and leaves the appeal `filed`: the initial reviewer's own
      valid signature `403`; a non-physician credential type `403`; P3-E's signature over the
      initial determination presented as a reconsideration `401`; a signature over another
      appeal id `401`; an untimely appeal reconsidered without `goodCauseFound` `400`; an
      `untimely` dismissal of a timely appeal `400`.
- [ ] With the clock past an appeal's deadline and no sweep run, a reconsideration returns
      `409` and the appeal is `forwarded` with `deadline-lapsed`.
- [ ] Two sweeps over one lapsed appeal forward it once and emit one `review.appeal.forwarded`
      event. Memory live.
- [ ] The rationale sentinel from a stub `assess` appears in `GET /review/appeals/:id` and in
      the case file, and in no FHIR response, the reversal's included.
- [ ] `GET /fhir/metadata` is unchanged, and P3-D's `fhir-validate.yml` validates the captured
      reversal response against base R4 with zero errors.
- [ ] Ledger configured (checkable once P3-C has shipped; until then open with owner P3-C):
      each action appends its entry; `ledger:verify` exits 0, and exits non-zero on a chain
      whose `reconsideration.attested` key resolves to the cited determination's reviewer.
      With the ledger's database stopped, a reconsideration returns `503` and the appeal
      stays `filed`. Memory live.
- [ ] Auth enforced (checkable once P5-A has shipped; until then open with owner P5-A): a
      valid reconsideration from a registry entry naming principal `a`, sent with principal
      `b`'s token, returns `403`.

**Bookkeeping**

- [ ] `docs/STATUS.md` has a row for reconsideration, citing `appeal.e2e-spec.ts` by test
      title and stating that `forwarded` is a record, not a delivery.
- [ ] `CTL-HUM-03` moves from `planned` to `implemented` with a test anchor, and
      `governance/CONTROLS.md` is regenerated.
- [ ] `.context/architecture.md` lists the appeal routes, and "Before real data" lists the
      appeal table's filer, statement and evidence columns and the case file, with retention,
      encryption and access as owned items.
- [ ] Every fixture filer and reviewer is labelled synthetic, and `lint-data.mjs` passes.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Risks and open questions

**Open questions that change scope.**

1. **Appeals of a lapsed initial decision.** § 422.568(f) makes them appealable, and P3-E's
   sweep finds them. Accepting them means a pended case leaves P3-E's queue when an appeal is
   filed on it, a reconsideration with no initial reviewer to exclude, and a third case
   status. That is about two more days and takes the PRD to L. **Recommendation: out**, with
   `422` and the STATUS row saying so.
2. **A reconsideration after the deadline.** This draft refuses it and forwards, following
   § 422.590(d) and (g). The alternative accepts a late reversal, since it favours the
   enrollee. The CFR text does not provide for it, and CMS's sub-regulatory guidance was not
   read for this draft. **Recommendation: as drafted**, unless review cites guidance.
3. **The ADR.** This draft keeps the case table and narrows ADR 0010's trigger. The
   alternative takes the trigger literally and moves the case layer onto a durable-execution
   engine, which ADR 0001 rejected for the agent and ADR 0010 deferred for the case. That is
   a separate PRD of size L before this one. **Recommendation: the narrowed trigger.**
4. **The ledger edge.** P3-C is being implemented. If it ships first, its four new kinds and
   the verifier's non-involvement check are about a day inside this PRD, which is the top of
   M. If review wants the ledger criteria closed at merge, P3-C becomes a `depends_on` edge.
   **Recommendation: no edge**, as P3-E's review decided (`P3-E-...md:770-776`).

**Risks.**

- **Involvement is reduced to who signed.** A colleague consulted on the initial denial, or a
  reviewer who read the case and passed it on, was "involved" in the plain sense of
  § 422.590(h)(1), and nothing here records either. The routes have no authenticated reader
  until P5-A, so even reads are anonymous. One person holding two `reviewerId`s defeats every
  layer. The control's note will say the rule is enforced against the signer of the initial
  determination, not against everyone involved.
- **The filing deadline counts from a proxy.** `decided_at` is not the date of a written
  notice, because none is sent. A plan that mails notices a day later would compute deadlines
  a day early, and the flag would be wrong in the filer's disfavour. Because nothing is
  refused on it, the cost is a flag a person must overrule.
- **The physician rule over-applies.** Requiring a physician credential for every
  reconsideration is § 422.590(h)(2)'s rule extended to denials that may not be about medical
  necessity. It is the conservative error, and it follows from P3-A's choice not to type the
  basis.
- **A drug or payment policy would silently get the wrong clock.** All four policies are
  items, so `reconsiderationDueBy` has one standard arithmetic. A Part B drug policy needs 7
  days (§ 422.590(c)) and a payment request 60 (§ 422.590(b)). Nothing in `PolicySchema`
  says which a policy is. The implementation should add a `requestType: 'item-or-service'`
  literal so a second type fails to parse rather than inheriting 30 days.
- **The forward is a record, not a delivery.** A reader of the STATUS row could take
  `forwarded` to mean the independent entity received something. The row, the route and the
  ADR all say otherwise; the risk is a summary elsewhere that drops the qualifier.
- **Software forwards without a person.** The lapse forward is the one action in this layer
  no clinician signs. It is the consequence § 422.590(d) and (g) fix, not a judgement, it
  moves the case towards independent review, and it carries no medical-necessity reading, so
  it is outside what P3-A forbids and what P3-D's SB 1120 reading rules out. A reviewer who
  reads "the tool shall not … delay" to cover any automated step on a case would disagree,
  and the ADR states the argument so it can be rejected on its terms.
- **Size.** Estimate: one and a half days for the table, migration and contract suite; half a
  day for the branded type and its tests; half a day for the clocks; one and a half for the
  five routes and signature checks; half a day for forwarding, the case file and the sweep;
  one for the e2e spec, STATUS, the control and the ADR. That is five and a half days, the top
  of M, against code that runs today, which is why it is not sized as unknown. Open question
  1 or a P3-C that lands first each adds a day or two and makes it L.
- **The regulatory reading is a portfolio's, not counsel's.** The CFR text was read from eCFR
  as current on 2026-10-07; sub-regulatory CMS guidance on Part C appeals was not.

## References

Every external source below was read on 2026-10-08.

- 42 CFR §§ 422.566, 422.574, 422.578, 422.580, 422.582 (through 89 FR 30827, 2024-04-23),
  422.584, 422.586, 422.590 (through 88 FR 22334, 2023-04-12), 422.592, 422.594 and 422.618,
  eCFR, up to date as of 2026-10-07: <https://www.ecfr.gov/current/title-42/part-422/subpart-M>
- 42 CFR §§ 438.402, 438.406, 438.408 and 438.410, eCFR:
  <https://www.ecfr.gov/current/title-42/part-438/subpart-F>
- HL7 Da Vinci PAS IG 2.2.1, <https://hl7.org/fhir/us/davinci-pas/2.2.1/en/>, the narrative
  pages listed in Problem
- HL7 Jira FHIR-24326, "2.3.5 appears to be referring to a denial case", resolution
  <https://jiradev.hl7.org/browse/FHIR-24326>
- NIST AI 100-1 (AI RMF 1.0), MANAGE 4.1, as copied in `governance/controls.yaml`
- PostgreSQL 16 documentation, `CREATE TABLE` (foreign keys referencing a unique constraint,
  partial unique indexes)
- `docs/adr/0001-langgraph-over-a-durable-execution-engine.md`,
  `docs/adr/0003-payer-domain-with-licensing-and-phi-as-the-boundary.md`,
  `docs/adr/0008-code-systems-the-repository-may-contain.md`,
  `docs/adr/0010-the-prior-auth-case-lives-above-the-graph.md`,
  `docs/prd/P3-A-clinician-gate.md`, `docs/prd/P3-C-decision-ledger.md`,
  `docs/prd/P3-D-payer-dataset-fhir-prior-auth.md`,
  `docs/prd/P3-E-clinician-review-queue.md`, `docs/prd/P5-A-a2a-server.md`
