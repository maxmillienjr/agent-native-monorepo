---
id: P3-A
title: Clinician-gate invariant enforced in the type system
tier: 3
status: accepted
size: S
depends_on: []
blocks: [P3-C, P3-D, P3-E]
issue: null
superseded_by: null
controls: [CTL-HUM-01]
---

# P3-A · Clinician-gate invariant enforced in the type system

## Problem

ADR 0003 states a behavioural rule and gives it no mechanism. Its decision section reads:
"the agent must not present itself as **making** a medical-necessity determination … any
demo output that reads as an autonomous denial is a defect, not a feature"
(`docs/adr/0003-payer-domain-with-licensing-and-phi-as-the-boundary.md:53-58`). Reviewer
rule 10 repeats it as a check applied by hand (`.agents/reviewer.md:47-48`). Nothing in the
code enforces it, because nothing in the code can express it yet.

There is no determination anywhere in the repository. A case-insensitive search of every
`.ts`, `.tsx` and `.json` file outside `node_modules` and `dist` for `prior auth`,
`denial`, `determination`, `clinician`, `payer`, `adverse` and `attestation` returns no
file. What the graph can produce is the `AgentStateSchema` in `graph/state.ts:35-47`, and
what leaves the service is `RunResponse`: a conversation, an `outcome` of `success`,
`error` or `partial` (`packages/shared-types/src/memory.schema.ts:25`), token counts and
retrieved context (`packages/agent-contracts/src/run-response.schema.ts:10-17`). P3-D is the
PRD that adds a synthetic dataset and a FHIR prior-authorization surface; it has no file,
and this PRD must not build it.

Three facts about the current code decide what a type-level gate can and cannot promise.
Each was checked by compiling a probe file inside `apps/agent-service/src` with
`yarn typecheck` on 2026-09-26 (TypeScript 5.9.3, `@langchain/langgraph` 0.4.10, Zod
3.25.76). The probe was deleted afterwards.

- **LangGraph does not type-check a node's return value against the state annotation.**
  Given `Annotation.Root({ recommendation: Annotation<AgentRecommendation | undefined> })`,
  all three of these compile without error: an inline node returning
  `{ recommendation: denial }`, one returning `{ determination: denial }` (a key the
  annotation does not declare), and one returning `{ recommendation: 42 }`. The same
  returns from a function whose declared type is `Promise<Partial<State>>` fail — TS2322
  for the wrong value and TS2353 for the undeclared key. Every node file in
  `agent/nodes/` declares that return type (`plan.node.ts:21`, `egress.node.ts:7`), but the
  seven wrappers in `graph/graph.ts:54-94` are untyped arrow functions, so a node written
  inline there is unchecked.
- **The service already casts graph state through `unknown`.** `runs.service.ts:294`
  returns `buildRunResponse(result as unknown as AgentState)` and `runs.service.ts:332`
  does the same for the traced path. Whatever the channel types say, the value handed to
  `buildRunResponse` is asserted, not checked.
- **The response is never validated on the way out.** `RunResponseSchema` is parsed in
  `test/runs.e2e-spec.ts:62` and in its own unit test, and nowhere in `src/`.
  `buildRunResponse` (`egress.node.ts:25-34`) builds the object field by field and returns
  it. A checkpoint restored by the `PostgresSaver` (`graph.ts:107`) is deserialized JSON
  that no schema sees either.

So the type system can make a denial without an attestation unrepresentable and can keep
its constructor out of the agent's reach, but a value typed that way can still be forged
with a cast, and there is today no runtime check at the boundary that would catch it.

## Why it matters

The rule the invariant encodes is regulatory, and it is asymmetric: an adverse
determination requires a qualified human reviewer; an approval does not. Every source below
was read in its primary text on 2026-09-26.

| Source                                                                                                     | What it requires                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Adverse only?                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 42 CFR § 422.566(d) — Medicare Advantage                                                                   | "If the MA organization expects to issue a partially or fully adverse medical necessity … decision based on the initial review of the request, the organization determination must be reviewed by a physician or other appropriate health care professional with expertise in the field of medicine or health care that is appropriate for the services at issue", holding "a current and unrestricted license", "before the MA organization issues the organization determination decision." | Yes — "partially or fully adverse".                                                              |
| 42 CFR § 438.210(b)(3) — Medicaid managed care contracts                                                   | "any decision to deny a service authorization request or to authorize a service in an amount, duration, or scope that is less than requested, be made by an individual who has appropriate expertise in addressing the enrollee's medical, behavioral health, or long-term services and supports needs."                                                                                                                                                                                      | Yes — denial, or less than requested. Not limited to medical necessity. Does not say "licensed". |
| Cal. Health & Safety Code § 1367.01(e), in force before SB 1120                                            | "No individual, other than a licensed physician or a licensed health care professional who is competent to evaluate the specific clinical issues involved … may deny or modify requests for authorization of health care services for an enrollee for reasons of medical necessity." Subdivision (d) lets "health plan personnel" approve.                                                                                                                                                    | Yes — deny or modify; approval by plan personnel is expressly allowed.                           |
| Cal. SB 1120 (Stats. 2024, ch. 879, approved 2024-09-28), adding § 1367.01(k) and Ins. Code § 10123.135(j) | Where a plan uses "an artificial intelligence, algorithm, or other software tool" for utilization review, the tool "shall not deny, delay, or modify health care services based, in whole or in part, on medical necessity. A determination of medical necessity shall be made only by a licensed physician or a licensed health care professional competent to evaluate the specific clinical issues involved".                                                                              | Deny, delay, or modify.                                                                          |
| CMS HPMS memo, 2024-02-06, FAQs on CMS-4201-F, question 2                                                  | "An algorithm or software tool can be used to assist MA plans in making coverage determinations", but "algorithms or artificial intelligence alone cannot be used as the basis to deny admission or downgrade to an observation stay"; the decision must rest on "the individual patient's circumstances".                                                                                                                                                                                    | Assistance allowed; denial on the algorithm alone is not.                                        |
| NCQA UM FAQs, 2024-05-15 and 2025-04-15                                                                    | "NCQA UM standards do not allow the use of AI to make medical necessity denial decisions, or any appeal decisions." Software may approve if it uses the organization's clinical criteria, but "Organizations may not use the software to make any denial decisions; those must be made by an appropriate clinical professional."                                                                                                                                                              | Yes — and says outright that software may approve.                                               |

**What CMS-0057-F does and does not say.** The CMS Interoperability and Prior Authorization
Final Rule (89 FR 8758, 2024-02-08) requires impacted payers to give a specific reason for a
denied prior authorization and to decide within 72 hours (expedited) or seven calendar days
(standard), both from 2026-01-01, and to run a Prior Authorization API from 2027-01-01. It
does not itself say who makes the decision. Its preamble points to the rule that does:
before an MA plan issues a prior authorization denial based on medical necessity, "the
decision must be reviewed by a physician or other appropriate health care professional …
per 42 CFR 422.566(d); this will apply to any denial of a prior authorization request,
regardless of whether the Prior Authorization API has been used" (89 FR 8872). CMS also
declined a commenter's request to expose "software tools/artificial intelligence (AI) tools
used; and persons involved in making the prior authorization decision" through the Provider
Access API (89 FR 8798). So the attestation this PRD models is an internal audit record
that P3-C carries, not a field any federal API requires a payer to publish. ADR 0003:55-57
attributes the human-reviewer assumption to CMS-0057-F's timelines; the operative text is
§ 422.566(d), and this PRD cites that instead. The ADR's decision is unaffected.

The consequence for a reader who knows the domain: an agent that can emit a denial, however
the prompt is worded, is a software tool that can do what § 1367.01(k)(2) says it "shall
not". Making that impossible to
compile — and impossible to serialize — is a stronger statement than a reviewer rule, and it
is checkable in thirty seconds by reading one type test.

## Scope

- `packages/determination` (`@repo/determination`): the determination types, their Zod
  schemas, and two entry points — `.` for everything the agent may use, and `./clinician`
  for the one constructor that produces an adverse determination.
- A `disposition` channel on the graph state, typed so it can hold an automated approval or
  a referral to a clinician and nothing else.
- Explicit `Promise<Partial<AgentState>>` return types on the seven wrappers in
  `graph/graph.ts`, so an inline node is checked the way a node file already is.
- `RunResponse` gains an optional `disposition`, and `buildRunResponse` parses its result
  through a strict `RunResponseSchema`, so the invariant is enforced on the bytes that leave
  the service and not only on the types that produced them.
- An ESLint `no-restricted-imports` rule forbidding `@repo/determination/clinician` under
  `apps/agent-service/src/agent/**`, with a test that proves it fires.
- Type-level tests (`*.test-d.ts`) checked by `yarn turbo typecheck`, and runtime tests for
  the schemas and the egress parse.
- `.context/conventions.md` and `.agents/reviewer.md` rule 9 name the `./clinician`
  subpath as the one deliberate exception to "everything exports through `src/index.ts`",
  and `docs/STATUS.md` gains a row.

### Non-goals

- **Anything that produces a disposition.** No node in this PRD writes `disposition`; the
  channel exists, is typed, and is gated, and stays `undefined` on every run. A toy producer
  would be a prior-authorization workflow with no request, no criteria and no data behind
  it — the thing ADR 0003 calls worse than none. **P3-D** owns the producer, the synthetic
  requests it reads, and the FHIR surface that returns the result.
- **A clinician endpoint.** `attestAdverseDetermination` is exported and unit-tested; no
  HTTP route calls it. **P3-E** owns the review surface that does (split from P3-D at
  review, 2026-09-26).
- **Proving a human attested.** The types guarantee an adverse determination carries an
  attestation record; they cannot guarantee the record describes a real review by a real
  reviewer. Binding an attestation to an authenticated identity and making it tamper-evident
  is **P3-C**.
- **Timeliness.** CMS-0057-F's 72-hour and seven-day windows, and whether a referral is a
  "delay" in SB 1120's sense, are properties of a request's lifecycle, which does not exist
  until **P3-D**.
- **Free text.** `plan` writes the model's prose into `messages` (`plan.node.ts:48`). A
  sentence reading "this request is denied" is a string, and no type can forbid it. The rule
  this PRD enforces is on the structured determination. Keeping user-visible prior-auth
  output sourced from the structured channel is **P3-D**'s design constraint.
- **Appeals.** NCQA requires same-or-similar specialist review for an appeal decision, which
  is a second reviewer constraint on a second kind of decision. There is no appeal until
  there is a request to appeal; **P3-D** owns it.
- **CPT or real data.** Every fixture is fabricated and labelled so (ADR 0003, items 1-2);
  reviewer identifiers are obviously synthetic strings, not NPIs.

## Design

### The asymmetry, as types

Every source above scopes its reviewer requirement to adverse outcomes, § 1367.01(d) lets
plan personnel approve, and NCQA says outright that software may. The types say the same
thing structurally:

```ts
// packages/determination/src/determination.ts
declare const adverse: unique symbol; // not exported — no other module can name it

export const ClinicianAttestationSchema = z.object({
  reviewerId: z.string().min(1),
  credential: z.object({ type: z.string().min(1), jurisdiction: z.string().min(1) }),
  attestedAt: z.string().datetime({ offset: true }),
});
export type ClinicianAttestation = z.infer<typeof ClinicianAttestationSchema>;

/** Final and favourable. Approves the request as submitted — there is no field to reduce it. */
export interface AutomatedApproval {
  readonly kind: 'automated-approval';
  readonly criteriaMet: readonly string[];
}

/** Not a decision. The agent's reading of the criteria, handed to a person. */
export interface ClinicianReferral {
  readonly kind: 'refer-to-clinician';
  readonly findings: readonly CriterionFinding[];
}

export interface AdverseDetermination {
  readonly kind: 'denial' | 'partial-approval';
  readonly specificReason: string; // CMS-0057-F: a specific reason for every denial
  readonly attestation: ClinicianAttestation;
  readonly [adverse]: true;
}

export type AgentDisposition = AutomatedApproval | ClinicianReferral;
export type Determination = AutomatedApproval | ClinicianApproval | AdverseDetermination;
```

Three decisions are carried in that sketch.

- **The agent's type is `AgentDisposition`, not "recommendation".** One of its two variants
  is a final decision — an automated approval is a determination, and the NCQA FAQ says
  software may make it. The other is a referral, and it deliberately carries findings per
  criterion rather than a suggested outcome. A referral labelled "recommend deny" asks the
  reviewer to confirm the tool's outcome, which sits close to what the CMS FAQ rules out —
  an algorithm "alone" as "the basis to deny". A referral that says which criteria were and
  were not evidenced is what the same FAQ calls a tool used "to assist".
- **Every adverse outcome needs the attestation, whatever its basis.** § 422.566(d) and SB
  1120 are scoped to medical necessity, and so is the question NCQA's FAQs answer;
  § 438.210(b)(3) covers "any decision to deny" with no such qualifier. The type takes the
  stricter reading, because a gate that has to be told the basis of a denial before it
  applies can be routed around by mislabelling the basis.
- **Partial approval is adverse.** § 438.210(b)(3) names "less than requested",
  § 1367.01(e) says "deny or modify", and § 422.566(d) says "partially or fully adverse".
  `AutomatedApproval` has no quantity, duration or scope field, so the only way to approve
  less than was asked is `partial-approval`, which requires an attestation.

`ClinicianApproval` carries an attestation too — a person made it and the ledger should say
who — but carries no brand, because nothing requires it to be gated.

### The constructor, and who can reach it

```ts
// packages/determination/src/clinician.ts — reachable only as '@repo/determination/clinician'
export function attestAdverseDetermination(
  input: { kind: 'denial' | 'partial-approval'; specificReason: string },
  attestation: ClinicianAttestation,
): AdverseDetermination;
```

It parses both arguments with Zod, rejects an empty `specificReason`, and is the one place
in the repository that asserts the brand. The `unique symbol` is declared in
`determination.ts` and never exported, so an object literal elsewhere cannot satisfy
`AdverseDetermination`: the probe on 2026-09-26 produced TS2741, "Property '[adverseBrand]'
is missing".

`package.json` gains the first `exports` map in the repository (no package has one today):

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./clinician": { "types": "./dist/clinician.d.ts", "default": "./dist/clinician.js" }
}
```

Under `moduleResolution: NodeNext` (`packages/tsconfig/base.json`) TypeScript honours it: in
a scratch package on 2026-09-26, importing `./clinician` resolved and a deep import of
`dist/clinician.js` failed with TS2307. The map stops the deep import; it does not stop
`@repo/determination/clinician`, which is public by design because P3-E's review surface
needs it. Declaring or not declaring the dependency in `package.json` does not help either:
`nodeLinker: node-modules` (`.yarnrc.yml:1`) symlinks every workspace into
`node_modules/@repo/`, so an undeclared workspace import resolves. The boundary is therefore
a lint rule, scoped to the directory that holds the graph:

```js
// apps/agent-service/eslint.config.js
{
  files: ['src/agent/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{ name: '@repo/determination/clinician',
                message: 'The agent may approve or refer. Only a clinician can deny. See P3-A.' }],
    }],
  },
}
```

`yarn turbo lint` runs in CI (`.github/workflows/ci.yml:26`), and a lint rule that has
never fired proves nothing, so a Vitest test in `apps/agent-service` lints a two-line fixture
with ESLint's `lintText` twice — once at a path under `src/agent/nodes/`, expecting exactly
one `no-restricted-imports` error, and once under `src/runs/`, expecting none.

**Not Zod's `.brand()`.** A branded Zod schema is a second constructor: `z.infer` of
`.brand<'AdverseDetermination'>()` is the branded type, and its `.parse` returns one from any
input with the right shape. The probe confirmed it compiles. The minting schema therefore
lives only in `./clinician`; `.` exports `DeterminationRecordSchema`, which validates the
same shape and returns an unbranded record, so a reader (P3-C verifying the ledger) can check
a stored determination without being able to mint one.

### The graph

`state.ts` gains `disposition: AgentDispositionSchema.optional()` on `AgentStateSchema`, and
`graph.ts` gains `disposition: Annotation<AgentState['disposition']>` beside `extraction`
(`graph.ts:37-40` explains why both are needed). `WorkingMemorySchema` in `memory-core` is
not touched — `extraction` sets the precedent of a field that lives only on
`AgentStateSchema`. No node is named `disposition`, so the channel-name collision in
`.context/workflows.md:49-58` does not arise.

Because LangGraph 0.4.10 does not check an inline node's return, each wrapper in
`graph.ts:54-94` gets an explicit return type:

```ts
type Node = (state: AgentState) => Promise<Partial<AgentState>>;
```

That turns "a node cannot put a denial in state" from a convention every node file happens
to follow into a property of the one place nodes are registered. Checked on 2026-09-26: an
async arrow typed `Node` — or checked with `satisfies Node` inline in `addNode` — that
returns `{ disposition: denial }` or `{ determination: denial }` fails with TS2322. Adding the channel changes
no prompt and no seam request, so no cassette needs re-recording (`.context/conventions.md`
lists what does).

### The boundary: what types cannot do

Types are erased, the repo already casts through `unknown` at `runs.service.ts:294` and
`:332`, and the probe confirmed that `{ … } as unknown as AdverseDetermination` compiles.
The runtime check is the one that holds:

```ts
export const RunResponseSchema = z
  .object({
    // … existing fields …
    disposition: AgentDispositionSchema.optional(),
  })
  .strict();
```

`AgentDispositionSchema` is a discriminated union on `kind` with two members; `denial` and
`partial-approval` are not among them, so parsing a response that carries one throws.
`.strict()` turns an unknown key into an error rather than a silent strip — without it, a
denial placed under any other key would be removed from the response and the defect would
never surface. `buildRunResponse` ends in `RunResponseSchema.parse(...)`. Both `execute`
(`runs.service.ts:294`) and `executeTraced` (`runs.service.ts:335`) build their response
through it, so the eval harness exercises the same check the HTTP path does. A restored checkpoint reaches egress by
the same route, so a tampered `disposition` in Postgres is caught there too.

SSE frames carry a node name and nothing else (`runs.service.ts:360-364`), so
`POST /runs/stream` has no disposition to leak and needs no change.

### How CI runs the type tests

`*.test-d.ts` files sit beside their source. Both `packages/determination/tsconfig.json` and
`apps/agent-service/tsconfig.json` include `src` (`apps/agent-service/tsconfig.json:7`), so
`tsc --noEmit` — the `typecheck` script in every workspace, run by `yarn turbo typecheck` at
`ci.yml:27` — checks them. Vitest does not execute them: its include is
`src/**/*.test.ts` (`apps/agent-service/vitest.config.ts:23`), which `.test-d.ts` does not
match, and a type test must not execute, because the lines under `@ts-expect-error` are
calls that would throw.

Both mechanisms bite under plain `tsc`, verified by the probe: an unused
`// @ts-expect-error` fails with TS2578, and a false `expectTypeOf(...).toMatchTypeOf<T>()`
fails with TS2344. No `vitest --typecheck` step is needed.

## Acceptance criteria

- [ ] `yarn workspaces list` includes `@repo/determination`, and its `package.json` has an
      `exports` map with exactly two keys, `.` and `./clinician`.
- [ ] `packages/determination/src/determination.test-d.ts` fails `yarn turbo typecheck` if
      any of these compiles: an object literal typed `AdverseDetermination`; a call to
      `attestAdverseDetermination` without an attestation; assigning an
      `AdverseDetermination` to `AgentDisposition`; an `AutomatedApproval` with a field that
      reduces what was requested.
- [ ] The same file asserts with `expectTypeOf` that no export of `.` returns a type
      assignable to `AdverseDetermination`, by mapping over `typeof import('./index.js')`.
- [ ] `apps/agent-service/src/agent/graph/disposition.test-d.ts` fails `yarn turbo typecheck`
      if a function typed `Node` can return `{ disposition: <AdverseDetermination> }`, or an
      undeclared key such as `{ determination: … }`, or if importing
      `@repo/determination/dist/clinician.js` resolves.
- [ ] Every `@ts-expect-error` in both files carries a one-line reason, and the pull request
      records one mutation run per file: the guarded error removed, `yarn turbo typecheck`
      failing with TS2578, the mutation reverted.
- [ ] Unit tests: `DeterminationRecordSchema` rejects a `denial` with no attestation and one
      with an empty `specificReason`; `AgentDispositionSchema` rejects `kind: 'denial'` and
      `kind: 'partial-approval'`; `attestAdverseDetermination` rejects an attestation whose
      `attestedAt` is not an ISO-8601 timestamp with an offset.
- [ ] `buildRunResponse` parses through `RunResponseSchema`, which is `.strict()`. A unit test
      passes a state whose `disposition` holds a cast `AdverseDetermination` and asserts the
      parse throws; a second passes an extra top-level key and asserts the same.
- [ ] `yarn turbo test:service` passes unchanged, including `runs.e2e-spec.ts:62`, which parses
      the response independently. Model `stub` / memory `stub`.
- [ ] `EVAL_CASSETTE_MODE=replay yarn eval` on memory `live` produces the same per-grader
      results as on `main` — every response in that run now passes through the egress parse.
      Model `replay` / memory `live`. No model-`live` run is claimed; this PRD changes no
      prompt, and P1-C owns live runs.
- [ ] A Vitest test lints an import of `@repo/determination/clinician` at a path under
      `src/agent/` and gets exactly one `no-restricted-imports` error, and at a path under
      `src/runs/` gets none.
- [ ] `.context/conventions.md:19` and `.agents/reviewer.md:33` name `./clinician` as the one
      entry point deliberately absent from a barrel, and say why.
- [ ] `docs/STATUS.md` has a row for the clinician gate, status `stubbed`, owner P3-D: the
      gate runs on every response, and nothing yet writes the channel it guards.
- [ ] No fixture contains a CPT code, a real NPI, or anything that is not labelled synthetic.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Risks and open questions

- **The brand stops accidents, not adversaries.** `as unknown as AdverseDetermination`
  compiles. The design's answer is that such a value cannot leave the process through
  `RunResponse`; it does not stop code inside the process from treating a forged value as
  real. Banning assertions to the type with a custom lint rule is possible and not proposed:
  the repo already needs `as AgentState` at eight sites in `graph.ts` alone.
- **The gate guards a channel nothing writes.** Until P3-D there is no producer, so the
  `stubbed` status is the honest one and the runtime check has only ever seen `undefined`.
  If P3-D chooses a different shape for its output — a FHIR `ClaimResponse` rather than an
  `AgentDisposition` — the channel here is wasted and the types have to be adopted at that
  boundary instead. P3-D should be drafted against this PRD's types, which is why it is in
  `blocks`. **Decided at review, 2026-09-26:** these types are the domain model and FHIR is
  the wire format. P3-D maps an `AgentDisposition` or a clinician's determination onto a
  `ClaimResponse` at its HTTP boundary; it does not replace them.
- **P3-C in `blocks` assumes its ledger records determinations.** Its index title says
  "decision ledger". If P3-C is scoped to the agent's own model decisions — the cassette's
  seam, ADR 0005 — it does not need these types and the edge should be removed.
  **Decided at review, 2026-09-26: the edge stays.** What an auditor reconstructs is who
  decided an adverse outcome and on what recommendation, so P3-C's ledger records
  determinations and attestations, with the agent's recommendation that preceded each.
- **Whether routing to a clinician is a "delay".** SB 1120 bars the tool from delaying
  services "based, in whole or in part, on medical necessity". This PRD does not read that
  clause, and makes no claim that `refer-to-clinician` satisfies it. It becomes a real
  question when P3-D gives a request a clock.
- **The regulatory reading is a portfolio's, not counsel's.** Each quoted requirement is
  from its primary text and each is scoped as the text scopes it. None of this is advice
  about compliance, which is ADR 0003's disclaimer position.
- **The first `exports` map.** It resolves under `tsc` NodeNext (checked). Node's ESM
  loader, Jest 29 via ts-jest, Vitest and tsx all honour `exports` too, but none of them
  imports `./clinician` in this PRD, so the first runtime import of it lands in P3-D.
- **Sized S on the grounds that every file it touches already runs in CI.** The package,
  the channel and the lint rule are new code on paths that are exercised today. The one
  place a hidden defect can sit is the strict egress parse: `runs.e2e-spec.ts:62` has only
  ever parsed a response on the stub memory axis, so a live-store value that does not match
  `RetrievedContextItemSchema` — an `episodeId` that is not a UUID, say — would first
  surface as a failed run in the replay criterion. If it does, that is a real contract
  defect this PRD found, and fixing it may push the size to M.
- **LangGraph 1.x may type the update.** If P5-C's upgrade makes `addNode` check returns
  against the annotation, the `Node` alias becomes redundant; keep it until that is shown.
  P5-C is accepted and may land first, so the implementation re-runs the return-type probe
  on whichever LangGraph version is on `main` and records the result.
- **Amended at review, 2026-09-26, on P3-D's finding.** P3-D produces dispositions on a
  second graph and returns them as FHIR, so a `disposition` channel on the chat graph and a
  `disposition` field on `RunResponse` would never have a producer. Both move to P3-D.
  P3-A keeps the package, the `./clinician` subpath and its lint rule, the `Node` alias,
  the type tests — run against a fixture state annotation rather than the chat graph's — and
  the strict egress parse of `RunResponse`, which is worth having without a disposition in
  it. The implementation's first commit rewrites the Scope and the criteria that name the
  chat-graph channel, and says so.

## References

- 42 CFR § 422.566(d), https://www.law.cornell.edu/cfr/text/42/422.566
- 42 CFR § 438.210(b)(3), https://www.law.cornell.edu/cfr/text/42/438.210
- California SB 1120 (2024), ch. 879, amending Health & Safety Code § 1367.01 and Insurance
  Code § 10123.135,
  https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB1120
- CMS Interoperability and Prior Authorization Final Rule, CMS-0057-F, 89 FR 8758
  (2024-02-08), https://www.govinfo.gov/content/pkg/FR-2024-02-08/pdf/2024-00895.pdf —
  pages 8798 and 8872 for the passages cited
- CMS fact sheet for CMS-0057-F,
  https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-and-prior-authorization-final-rule-cms-0057-f
- CMS HPMS memo, "Frequently Asked Questions related to Coverage Criteria and Utilization
  Management Requirements in CMS Final Rule (CMS-4201-F)", 2024-02-06,
  https://www.aha.org/system/files/media/file/2024/02/faqs-related-to-coverage-criteria-and-utilization-management-requirements-in-cms-final-rule-cms-4201-f.pdf
- NCQA, UM / CR / PN FAQ directory,
  https://www.ncqa.org/programs/health-plans/utilization-management/faqs/um-cr-pn/
- `docs/adr/0003-payer-domain-with-licensing-and-phi-as-the-boundary.md` — the boundary
  this PRD mechanizes.
- `docs/prd/P1-G-task-axis-requirements.md` — the axis vocabulary the eval criterion uses.
