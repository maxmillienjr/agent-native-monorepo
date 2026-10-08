---
id: P3-D
title: Synthetic payer dataset and FHIR prior-authorization surface
tier: 3
status: in-progress
size: L
depends_on: [P1-A, P1-B, P3-A]
blocks: [P3-E]
issue: 84
superseded_by: null
controls: [CTL-DATA-01, CTL-DATA-02]
---

# P3-D · Synthetic payer dataset and FHIR prior-authorization surface

## Problem

P3-A gives the repository a type for what an agent may decide about a prior-authorization
request, and nothing that produces one. Its non-goals hand this PRD the producer, the
synthetic requests it reads, the FHIR surface that returns the result, the review surface a
clinician uses, the request's clock, the rule that user-visible output comes from the
structured channel, and appeals (`P3-A-clinician-gate.md:122-142`). Its `docs/STATUS.md` row
is `stubbed` with owner P3-D (`P3-A-clinician-gate.md:369-370`). `@repo/determination` does
not exist yet: `packages/` holds `agent-cassette`, `agent-contracts`, `eslint-config`,
`eval-harness`, `memory-core`, `shared-types`, `telemetry` and `tsconfig`, and P3-A is
`accepted`, not shipped (`docs/prd/README.md:161`).

Nothing in the repository speaks FHIR. `git grep -il fhir` outside `docs/` matches one file,
the vendored `.yarn/releases/yarn-4.13.0.cjs`. There is no payer dataset. The evaluation
harness ships one dataset (`dataset.ts:31`), the runner loads only that one
(`run-eval.ts:168`), and every task's input is a `RunRequest`: a session id and a list of
chat messages (`dataset.ts:107-111`).

The service cannot accept a FHIR request body today, for two reasons that are not visible
from reading the controller. Both were checked on 2026-09-26 with a probe spec in
`apps/agent-service/test/` that registered a `POST /fhir/Claim/$submit` controller under the
same global pipe `main.ts` installs; the spec was deleted afterwards.

- **The request-body pipe is global.** `main.ts:60` calls
  `app.useGlobalPipes(new ZodValidationPipe(RunRequestSchema))`, so every `@Body()` in every
  controller is parsed as a `RunRequest`. A FHIR `Bundle` posted as `application/json` got
  `400` with `"path":["sessionId"],"message":"Required"`. The service spec repeats the global
  pipe at `runs.e2e-spec.ts:39`, so it would hide a fix made in only one of the two places.
- **`application/fhir+json` is not parsed.** FHIR's JSON media type is
  `application/fhir+json`. Nest's default body parser reads `application/json` only, and the
  same `Bundle` posted with the FHIR media type reached the pipe as `undefined`:
  `"expected":"object","received":"undefined","path":[]`. A well-formed run body posted with
  that header failed the same way. The route itself resolved (a `400`, not a `404`), so the
  literal `$` in `Claim/$submit` is not the problem.

ADR 0003 forbids CPT codes and real PHI and says the check "should eventually be enforced …
until then it lives in `.agents/reviewer.md` as a rule a reviewer applies by hand"
(`0003-payer-domain-with-licensing-and-phi-as-the-boundary.md:71-73`). P4-A catalogues that
rule as CTL-DATA-01, status `procedural`, and assigns the automated detector to this PRD
(`P4-A-controls-as-code.md:98-104`, decided at review, `:426`). P4-A also names why the
obvious check does not work: "A five-digit CPT pattern collides with ports, ZIP codes,
timestamps and version numbers" (`:99-100`). Measured on 2026-09-26 over the 238 tracked
text files outside `.yarn/` and `yarn.lock`, a bare five-digit-token pattern matches 21
times in 4 files, and none of the matches is a medical code. Sixteen are the standard
number `42001` in P4-A, two are the host ports `25432` and `27687` at
`P5-C-langgraph-1x.md:53`, and three are `latencyMs` values in the two committed cassettes.
The standard number is also a syntactically valid Category I code, so no pattern can tell
the two apart without context.

## Why it matters

Prior authorization is the payer workflow that federal rulemaking now puts behind an API.
The CMS Interoperability and Prior Authorization Final Rule (CMS-0057-F, 89 FR 8758,
2024-02-08) sets decision deadlines that run "after receiving the request". Medicare
Advantage, Medicaid and CHIP must decide a standard request within 7 calendar days and an
expedited one within 72 hours, from 2026-01-01 (42 CFR 422.568(b)(1)(ii), 422.572(a),
440.230(e)(1)). QHP issuers on the federal exchanges are excluded from the timeframes. A
denial must carry "a specific reason for the denial" from the same date (§ 422.122(a)).
Impacted payers must run a Prior Authorization API "beginning January 1, 2027"
(§ 422.122(b)), and CMS's rule page, last modified 2026-08-31, still gives that date. The
API's required standards are FHIR 4.0.1, US Core and SMART App Launch. The HL7 Da Vinci
Prior Authorization Support (PAS) guide is recommended, not required (Table H3, 89 FR 8945),
and CMS currently lists PAS STU 2.0.1 and 2.1.0. A payer-domain
agent that a reader can check against the IG, against the clock, and against ADR 0003's
licensing boundary makes the domain claim testable. One that accepts chat messages and says
"prior authorization" in a prompt does not. The reviewer this tier is written for knows the
workflow. They will look for CPT in the fixtures, for an agent that can deny, and for a
deadline that starts when the payer received the request rather than when the software got
to it, in that order. Each of the three is a criterion below.

## Scope

This PRD is the intake half of prior authorization: a request arrives, the clock starts,
the agent reads the evidence against a policy, and the request is either approved or routed
to a clinician in the same HTTP exchange. What happens to a routed request afterwards is the
follow-on P3-E (see Risks).

- **A synthetic payer dataset.** One fictional payer, four medical policies keyed by HCPCS
  Level II codes, and 24 prior-authorization request bundles with per-criterion labels. Every
  resource is labelled synthetic in the FHIR way, and every identifier is synthetic by
  construction.
- **`packages/prior-auth` (`@repo/prior-auth`)**: Zod schemas for the FHIR R4 subset the
  surface reads and writes, the policy catalogue, the request clock, and the mapping from an
  `AgentDisposition` to a `ClaimResponse`.
- **A prior-authorization graph** in `apps/agent-service/src/agent/prior-auth/`, with four
  nodes, one model call, and an OTel span per node. The graph produces an `AgentDisposition`,
  P3-A's type, and nothing else.
- **`POST /fhir/Claim/$submit`** and **`GET /fhir/metadata`** on `agent-service`. That
  includes moving the `RunRequest` pipe off the global scope and parsing
  `application/fhir+json`.
- **A new cassette seam, `assess.criteria`**, so the prior-authorization suite replays the
  way the memory-recall suite does.
- **A prior-authorization evaluation suite**: 24 tasks, four graders, and one recorded
  cassette per task.
- **`scripts/lint-data.mjs`**, the CPT and synthetic-data detector ADR 0003 asks for, run by
  `yarn lint:docs`. It moves CTL-DATA-01 from `procedural` to `implemented`.
- **ADR 0008**, which records the code systems the repository may contain, extending ADR
  0003's decision without contradicting it.
- **An HL7 FHIR Validator job**, run on pull requests that touch the payer data or the FHIR
  module. It gates the committed bundles and captured responses on base R4 and US Core
  6.1.0, and reports how far they are from PAS 2.2.1.

### Non-goals

- **The pended lifecycle.** This covers the clinician review queue, the route that calls
  `attestAdverseDetermination`, `Claim/$inquire`, and the overdue detection a clock implies.
  So a pended `ClaimResponse` from this PRD is terminal as far as the API is concerned. The
  case is checkpointed under its own thread id so that a successor can resume it. _Amended
  at P3-E's review, 2026-09-26:_ P3-E does not resume the thread. It holds the case in a
  table, and the checkpoint stays as the audit record P3-B reads.
  **P3-E** owns all of it. P3-A handed the review surface to P3-D
  (`P3-A-clinician-gate.md:127-128`), so the split moves that hand-off, and the index has to
  record it (see Risks).
- **Appeals.** P3-A assigned them here (`:140-142`). There is nothing to appeal until a
  clinician can issue an adverse determination, which is P3-E. **P3-E**.
- **Denials of any kind, including administrative ones.** A request from a member whose
  coverage is inactive would be denied on eligibility, not medical necessity. P3-A's type
  takes the stricter reading and requires an attestation for every adverse outcome
  (`P3-A-clinician-gate.md:197-201`), so the agent refers it. **P3-E** owns
  the clinician who denies it.
- **CRD and DTR.** Coverage Requirements Discovery and Documentation Templates and Rules sit
  upstream of PAS in the provider's workflow. The dataset carries the documentation a DTR
  session would have gathered as a `DocumentReference`, and no CDS Hooks service or
  questionnaire is built. **No successor is proposed.** A payer-side showcase gets its
  signal from the decision half, and a CRD service is a second product.
- **X12 278 translation and a clearinghouse.** See "What is claimed" under Design. **No
  successor.** ADR 0008 keeps X12 code values out of the repository.
- **Exposing the surface through `apps/gateway`, and authenticating callers.** The gateway
  mounts one router (`server.ts:13`). P4-A decided at review that CTL-ACC-01 is planned
  under **P5-A**, whose A2A server covers the service's external surface
  (`P4-A-controls-as-code.md:428-433`).
- **Memory.** The prior-authorization graph neither retrieves nor reflects. Writing a
  member's clinical evidence into episodic or semantic memory is a data-retention decision
  with no owner and no reason yet. **P3-C**'s ledger records the determination and the
  recommendation that preceded it, which is the record an auditor needs.
- **Real data, CPT, or anything drawn from memory of a real case.** ADR 0003 items 1-3, now
  checked by `lint-data.mjs`.

## Design

### The dataset

**Why DME.** Prior authorization for procedures and imaging is coded in CPT, which ADR 0003
forbids, so a dataset built on those services cannot be committed. Durable medical equipment
is coded in HCPCS Level II, which ADR 0003 permits (`0003-...md:31-33`). It is also a real
prior-authorization workload. So the four policies are for DME items. Each code below was
checked against the NLM Clinical Tables HCPCS service on 2026-09-26:

| HCPCS Level II | Short descriptor (CMS)       | Criteria in the fictional policy | Typical evidence                               |
| -------------- | ---------------------------- | -------------------------------- | ---------------------------------------------- |
| `E0601`        | Cont airway pressure device  | 4                                | sleep study result, diagnosis, trial adherence |
| `E0470`        | Rad w/o backup non-inv intfc | 4                                | prior-device failure, diagnosis, study result  |
| `K0823`        | Pwc gp 2 std cap chair       | 5                                | mobility exam, home assessment, prior aids     |
| `E0260`        | Hosp bed semi-electr w/ matt | 3                                | positioning need, diagnosis, prescriber note   |

Diagnoses are ICD-10-CM (`G47.33`, `G12.21`, `M17.11` and a handful more, each checked the
same way). The criteria are invented for a fictional payer. They are structured the way
real criteria are, as thresholds, documented trials and required documentation, and they
are not any payer's or CMS's criteria. Each policy file says so in a `disclaimer` field.
ADR 0003 item 3 forbids "medical policy text" carried over from real payers, and a policy
paraphrased from a real one is still that.

**The fictional payer** is one organization with two plans. Its name is shared with P2-B's
corpus, which also invents payers (`P2-B-retrieval-ablation.md:229-234`), so that the two
datasets describe one fictional world. Whichever PRD lands first picks the names.

**Requests.** There are 24, six per policy, and each is a PAS-shaped request `Bundle` whose
first entry is a `Claim` with `use: preauthorization`. The bundle carries the `Patient`, the
`Coverage`, the requesting `Practitioner` and `Organization`, the insurer `Organization`,
one to three `Condition`s, and one to three `DocumentReference`s holding a plain-text
clinical note. The six requests per policy are stratified so that each stratum has a known
correct outcome:

| Stratum              | Constructed so that                                                         | Correct disposition  |
| -------------------- | --------------------------------------------------------------------------- | -------------------- |
| `all-met-structured` | every criterion is evidenced by a coded `Condition` or a stated measurement | `automated-approval` |
| `all-met-narrative`  | every criterion is evidenced, and at least one only in the note's prose     | `automated-approval` |
| `one-missing`        | one criterion has no evidence in the bundle                                 | `refer-to-clinician` |
| `contradicted`       | the note states a value that fails a threshold                              | `refer-to-clinician` |
| `ambiguous`          | the evidence for one criterion is hedged or undated                         | `refer-to-clinician` |
| `administrative`     | the `Coverage` is inactive on the date of service                           | `refer-to-clinician` |

There are two approvals and four referrals per policy. That ratio is not a claim about real
auto-approval rates. It is set so that the metric that matters most, a wrongful automated
approval, has 16 chances per trial set to occur.

**Labels** live beside the bundles in `labels.json`: for each request, the correct
disposition kind and, for each criterion, `met`, `not-met` or `insufficient`, with the ids
of the resources that evidence it. Labels are written before any model sees a bundle, in a
separate commit, and the suite report prints the file's sha256. That is P2-B's defence
against later label edits (`P2-B-retrieval-ablation.md:275-278`).

**Synthetic by construction.** A detector cannot prove that a record describes no real
person. So the dataset is built so that every identifying field is provably not real, and
`lint-data.mjs` checks each rule:

- Every resource carries `meta.security` with `HTEST` from
  `http://terminology.hl7.org/CodeSystem/v3-ActReason`. THO v7.4.0 defines it as "simulated
  or synthetic health data used for testing system capabilities outside of a production or
  operational system environment".
- Every `identifier.system` is under `https://example.org/`, which RFC 2606 reserves, with
  one exception. NPI-shaped practitioner identifiers use the NPI system with a check digit
  that fails the NPI Luhn check, so they can never have been issued.
- Every `HumanName` part ends in digits (`Rosa482`), which is Synthea's convention and
  cannot be mistaken for a real name.
- Telephone numbers are in 555-0100 to 555-0199, which NANPA reserves for fictional use.
  Addresses carry city and state only, so there is no postal code.
- Birth dates are real dates. On their own, with no name, identifier or address, they
  identify no one.

**Why hand-authored and not Synthea.** ADR 0003 names Synthea as safe
(`0003-...md:34-36`), and it can export FHIR R4. It is not used for three reasons. It
generates encounters and claims, not prior-authorization requests with a stratum. The
evidence a stratum needs, such as a hedged note or a contradicted threshold, would be
hand-edited into the output anyway. And its conditions and procedures are coded in SNOMED
CT (`http://snomed.info/sct` in `FhirR4.java`). NLM makes SNOMED CT free to use in the US
under the UMLS licence. It does not settle whether the codes can be redistributed in a
public repository ("Users should carefully read the license agreement before
re-distributing any content"). So ADR 0008 leaves SNOMED CT off its list, and every
generated file would need recoding before `lint-data.mjs` passed. Synthea itself emits no
CPT unless a user configures a code map. Its maintainers declined to ship one "due to
licensing issues" (synthea issue #403). It is also a JDK 17 dependency. Hand-authored
bundles written against a stratum table are smaller,
labelled at authoring time, and pass the detector by construction. The naming convention
above is borrowed from Synthea, and nothing else is.

**Layout.** The bundles and labels are evaluation data, and the policies are service
configuration:

```
packages/eval-harness/datasets/prior-auth/
  pa-e0601-all-met-structured.json   …24 task files (loadSuite reads every *.json here)
  bundles/pa-e0601-all-met-structured.bundle.json   …24 request bundles
  bundles/labels.json
  cassettes/                         one per task, recorded
packages/prior-auth/
  data/payer.json                    fictional payer, plans
  data/policies/e0601.json …         criteria catalogue, one file per HCPCS code
  src/fhir/                          Zod schemas for the R4 subset
  src/policy.ts  src/clock.ts  src/claim-response.ts  src/index.ts
```

`loadSuite` parses every `.json` in a dataset directory as a task and is not recursive
(`dataset.ts:198-205`). So the bundles go in `bundles/`, as the cassettes go in
`cassettes/` (`dataset.ts:33-44`), and the labels go in `bundles/labels.json`, not beside
the task files.

### The FHIR boundary

**What is claimed: "shaped after PAS 2.2.1", not conformant to it.** PAS 2.2.1 (STU 2,
published 2026-03-27, FHIR 4.0.1) is the current version and the one the Inferno PAS test
kit covers, alongside 2.0.1. Two facts decide the claim, and both were read from the
published StructureDefinitions on 2026-09-26.

- **A conformant PAS `Claim` needs X12 codes this repository cannot hold.** In
  `profile-claim`, `item.category` is 1..1 with a required binding to X12 value set 1365.
  `item.extension:certificationType` (X12 1322) and `item.extension:requestType` (X12 1525)
  are both 1..1 with required bindings. A PAS `ClaimResponse` reports an approval or a pend
  through the `reviewAction` extension, which is bound to X12 code list 306. PAS's value
  sets say "All X12 work products are copyrighted", and the IG points implementers to X12
  for licensing. ADR 0003 does not mention X12. This PRD treats X12 code values the way ADR
  0003 treats CPT (see ADR 0008 below), so no conformant PAS instance can be committed. The
  other required bindings can be met: `item.productOrService` admits HCPCS Level II,
  `diagnosis` admits ICD-10-CM, and `item.location[x]` admits CMS Place of Service codes.
- **A PAS server must support subscriptions.** "Implementers SHALL support subscriptions to
  provide the final response" (§spec-51), over rest-hook only. It must also support
  `$inquire`, whose output is a `Parameters` of response bundles and not a single `Bundle`.
  Neither is in this PRD.

So what is built is a base-R4 exchange that follows PAS's shape: the `Claim/$submit`
operation name, one `Bundle` in and one `Bundle` out, a `Claim` first on the request (PAS
invariant `ClaimFirst`), a `ClaimResponse` first on the response (`ClaimResponseFirst`),
`Claim.use = preauthorization`, and `Claim.priority` as PAS requires it (1..1). Where PAS
uses an X12 code, this surface uses the base R4 element: `ClaimResponse.outcome` is
`complete` for an approval and `queued` for a pend. PAS excludes `queued` from its outcome
value set and marks a pend with X12 `A4` under `outcome: complete`. The CapabilityStatement
says "shaped after PAS 2.2.1" in its description and does not `instantiate` a PAS
CapabilityStatement. If X12 codes are ever permitted, the same design becomes conformant by
adding four codes and the subscription channel. That is the first open question below.

CMS-0057-F allows a FHIR-only exchange. The PAS IG requires an intermediary to translate to
X12 278 "if necessary to meet the HIPAA transaction requirements" (§use-2). CMS's
enforcement discretion letter of 2024-02-28 says no enforcement action "will … be taken
against HIPAA covered entities that choose to not use the X12 278 standard and instead use
an all-FHIR® Prior Authorization" API, and PAS's index says trading partners under that
discretion "can disregard" the translation requirements.

**Validation: Zod at runtime, `@types/fhir` at compile time, the HL7 validator in CI.**

- **Zod** parses every request at the boundary, as `.context/conventions.md` makes it the
  source of truth. The schemas cover only the subset the surface reads and writes: `Bundle`,
  `Claim`, `ClaimResponse`, `Patient`, `Coverage`, `Practitioner`, `Organization`,
  `Condition`, `DocumentReference`, `CapabilityStatement` and `OperationOutcome`. Unknown
  elements are passed through, not stripped, because FHIR permits extensions a subset schema
  cannot enumerate.
- **`@types/fhir`** (0.0.44, MIT, ships `r4`) supplies the R4 interfaces. Each schema is
  declared `satisfies z.ZodType<fhir4.Claim>` and so on, so a schema that drifts from base
  R4 fails `yarn turbo typecheck`. It is a devDependency with no runtime cost.
- **The HL7 FHIR Validator** is the reference implementation of profile validation, and the
  only candidate that checks slicing, cardinality and FHIRPath invariants. Three
  alternatives were considered and rejected. `fhir-zod` 1.0.0 generates base-spec schemas and
  says it does not cover "profile resolution or slicing". `@medplum/core`'s
  `validateResource` loads profiles, but it is a second implementation of the thing a
  reader would check against the reference, and it would be a runtime dependency used only in
  tests. Hand-written Zod per profile would duplicate the profile and drift from it. The cost
  of the reference validator is real. `validator_cli.jar` 6.10.4 is about 201 MB, needs a
  Java 17 runtime, and downloads IG packages from `packages.fhir.org` when it runs. So it
  gets its own workflow, `fhir-validate.yml`, and stays out of `ci.yml`. The trigger is
  `pull_request` with a `paths` filter on `packages/prior-auth/**`,
  `packages/eval-harness/datasets/prior-auth/**` and `apps/agent-service/src/fhir/**`, plus
  a weekly schedule. The jar and the package cache are cached and keyed on the pinned
  versions. Terminology validation is off (`-tx n/a`), because a job that calls
  `tx.fhir.org` fails whenever that server does.

What the job gates and what it reports are separate. **Gated:** every committed bundle and
every response the service spec captures validates against base R4, and each `Patient`,
`Practitioner`, `Organization`, `Coverage` and `Condition` validates against US Core 6.1.0,
with zero errors. That is the US Core version CMS lists for the API now that 3.1.1 expired
on 2026-01-01. **Reported, not gated:** the same instances against PAS 2.2.1's
`profile-pas-request-bundle` and `profile-pas-response-bundle`, with the error list written
to the job summary. The expected errors are exactly the missing X12 elements named above,
and the criterion below checks that no other error appears. That list is the precise
distance between this surface and PAS, and it is published rather than asserted.

### The HTTP surface

```
POST /fhir/Claim/$submit     Content-Type: application/fhir+json | application/json
  200  Bundle (PAS response shape): entry[0] ClaimResponse
  400  OperationOutcome        body is not a Bundle, or entry[0] is not a Claim
  422  OperationOutcome        a Claim the surface cannot process (no item, unknown insurer)
GET  /fhir/metadata          200  CapabilityStatement
```

**The two fixes the probe found.** `ZodValidationPipe(RunRequestSchema)` moves from
`app.useGlobalPipes` (`main.ts:60`) to the two `@Body()` parameters in `runs.controller.ts`,
and the matching line in `runs.e2e-spec.ts:39` is deleted. The pipe then lives in exactly
one place, the controller that needs it. `main.ts` registers a JSON body parser for
`application/fhir+json` beside the default one, through Nest 11's `app.useBodyParser` or
the Express equivalent, whichever the implementation shows works. An unparseable body returns an `OperationOutcome`, not the global exception filter's JSON.

**Synchronous.** The agent's work is one model call, a few seconds and not days, so
`$submit` runs the graph inline and returns a final or pended `ClaimResponse` in the same
exchange. PAS publishes a pended response bundle among its examples
(`ReferralPendingAuthorizationResponseBundleExample`). A pend is a complete answer to
`$submit`, and the decision arrives later by subscription or `$inquire`, both of them
P3-E. An asynchronous `$submit` would give the tool a queue of its own, and a queue the
tool holds is the thing the SB 1120 reading below rules out.

**The mapping is the only place FHIR meets the domain types.** P3-A decided at review that
the determination types are the domain model and FHIR is the wire format
(`P3-A-clinician-gate.md:387-389`):

```ts
// packages/prior-auth/src/claim-response.ts
export function toClaimResponse(
  claim: PasClaim,
  disposition: AgentDisposition, // from '@repo/determination' — the only input it accepts
  policy: Policy,
  clock: { respondedAt: Date },
): PasClaimResponse;
```

The mapping parses `disposition` through `AgentDispositionSchema` before reading it. That
schema's union has no `denial` or `partial-approval` member
(`P3-A-clinician-gate.md:307-308`), so a forged adverse value throws here as it does at
`RunResponse`'s egress. The `automated-approval` variant maps to `outcome: complete` with
a `preAuthRef` and a `preAuthPeriod`. The `refer-to-clinician` variant maps to
`outcome: queued` with neither. No branch produces `error`, `partial` or denial wording,
and a unit test drives both variants through the mapping to show it.

**No model text in the response.** P3-A left "keeping user-visible prior-auth output sourced
from the structured channel" to this PRD (`P3-A-clinician-gate.md:136-139`). The
`ClaimResponse`'s `processNote` and `disposition` strings are built from a fixed template
and the policy catalogue's criterion titles. The model's per-criterion rationale stays in
graph state and the checkpoint, where P3-E's reviewer reads it. A test enforces this. A
stub model returns a rationale containing a sentinel string, and the test asserts that the
serialized response does not contain it.

**`packages/prior-auth` imports `@repo/determination`'s `.` entry point only.** The FHIR
controller lives at `apps/agent-service/src/fhir/`, outside `src/agent/`, because P3-E's
clinician route will import `@repo/determination/clinician`, and P3-A's lint rule forbids
that import under `src/agent/**` (`P3-A-clinician-gate.md:244-255`).

### The graph

It is a second compiled graph. Branching the chat graph was considered and rejected. That
graph's `ingress` parses a `RunRequest` (`ingress.node.ts:15`) and its middle five nodes
retrieve, plan, act, distill and reflect conversation. A prior-authorization request would
share `egress` with it and nothing else.

```
START → intake → lookup → assess → dispose → END
```

| Node      | I/O               | Does                                                                                                                                                                                                                                                                                           |
| --------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intake`  | pure              | Parses the bundle with the Zod subset, extracts the HCPCS code, diagnoses, coverage period and priority, and writes `receivedAt` (handed in by the controller) and `decisionDueBy`                                                                                                             |
| `lookup`  | pure              | Finds the policy for the HCPCS code. None found, or coverage inactive on the service date, sets a reason and skips `assess`                                                                                                                                                                    |
| `assess`  | model, `IO_RETRY` | One call through the new `assess.criteria` seam. The call gets the criteria and the bundle's evidence text and returns a finding per criterion: `met`, `not-met` or `insufficient`, the cited resource ids, and a rationale. Parsed with Zod the way `parseExtraction` is (`extraction.ts:35`) |
| `dispose` | pure              | Code, not model: `automated-approval` if and only if every criterion is `met` with at least one citation that resolves to a resource in this bundle, otherwise `refer-to-clinician` carrying every finding                                                                                     |

Three decisions are in that table.

- **The model never chooses the disposition.** It reports findings. `dispose` is a
  deterministic function of the findings and the bundle, so the rule for when software may
  approve is ten lines a reviewer can read, not a prompt. That follows the CMS FAQ's line
  between a tool that assists and one that decides (`P3-A-clinician-gate.md:75`).
- **A citation that does not resolve downgrades the finding to `insufficient`.** CDI's
  guidance on SB 1120 (2025-05-05) says a tool must base its decision on "the insured's
  medical or other clinical history" and "individual clinical circumstances", and must not
  "base its determination solely on a group dataset". A `met` finding that cites nothing in
  this member's bundle is one the tool cannot show it made from the member's record.
- **`CriterionFinding` is defined here and lives in P3-A's package.** P3-A's
  `ClinicianReferral` carries `findings: readonly CriterionFinding[]`
  (`P3-A-clinician-gate.md:174`) and never defines the type. This PRD proposes the
  shape below. It belongs in `@repo/determination`, whichever PRD is implemented first.

```ts
export interface CriterionFinding {
  readonly criterionId: string; // a key of the policy's criteria, checked by `dispose`
  readonly status: 'met' | 'not-met' | 'insufficient';
  readonly evidence: readonly string[]; // `ResourceType/id` references into the bundle
  readonly rationale: string; // model text; never serialized to the ClaimResponse
}
```

Every node gets an `agent.node.<name>` span (`CLAUDE.md`, Key Rules). `intake` sets
`prior_auth.received_at`, `prior_auth.priority` and `prior_auth.decision_due_by`, and
`dispose` sets `prior_auth.disposition` and `prior_auth.elapsed_ms`. No node name collides
with a channel (`.context/workflows.md:49-58`). The channels are `request`, `receivedAt`,
`decisionDueBy`, `policy`, `findings` and `disposition`. The nodes are typed with P3-A's
`Node` alias, so an inline node that returns an adverse value fails `yarn turbo typecheck`
here as it does in the chat graph. The graph compiles with the service's checkpointer, with
the case id as `thread_id`, and the case id is `ClaimResponse.identifier`. That checkpoint
is what P3-E resumes. On the unconfigured memory axis the checkpointer is `null`
(`runs.service.ts:287`), and the pended case lives only in the response. That is the
existing axis rule, not a new fallback.

**The seam.** `ModelDeps` gains `assess: { assessCriteria(criteria, evidence) }`, and
`SEAMS` gains `'assess.criteria'` (`packages/agent-cassette/src/types.ts:27-33`). The
existing cassettes never call it, so they replay unchanged. The stub model returns
`insufficient` for every criterion, so on the stub axis every request is referred. That
makes the stub axis useful for the HTTP and mapping tests, and useless for grading the
agent.

### The request clock, and the SB 1120 question

```ts
// packages/prior-auth/src/clock.ts
export type Priority = 'expedited' | 'standard';
export function decisionDueBy(receivedAt: Date, priority: Priority): Date;
// expedited: receivedAt + 72h; standard: receivedAt + 7 × 24h
```

- **`receivedAt` is the server's clock at the controller**, taken through an injected
  `Clock` provider so tests can fix it. It is not `Claim.created`, which the submitter
  asserts. The rule counts from "receiving the request" (§ 422.568(b)(1)(ii),
  § 440.230(e)(1)), and the payer's receipt is the only receipt it can attest to.
- **Priority** comes from `Claim.priority`, which PAS makes 1..1 with an example binding to
  base R4's `process-priority`. `stat` means expedited and anything else means standard.
  PAS's `levelOfServiceType` extension (0..1) is X12-bound and is not read.
- **The regime is CMS-0057-F's, and only that.** The fictional plans are modelled as
  impacted payers under the Medicare Advantage timeframes. A state clock with different
  arithmetic would be a second function beside this one, not a parameter of it.
- **Seven calendar days is computed as 168 hours from receipt.** That is the earliest
  instant any reading of "calendar days" allows, so it is the conservative one.

**Is routing to a clinician a "delay" under SB 1120?** P3-A left this open until a request
had a clock (`P3-A-clinician-gate.md:396-399`). The statute says the tool "shall not deny,
delay, or modify health care services based, in whole or in part, on medical necessity"
(Cal. Health & Safety Code § 1367.01(k)). CDI's guidance repeats the sentence and does
not define "delay". This PRD adopts one reading and builds the three invariants that reading
depends on, so that a reviewer can check the invariants even if they reject the reading.

The reading: the baseline is a workflow where every request goes to a clinician. Against
that baseline, a tool that approves some requests and refers the rest immediately shortens
the time to a decision for the first group and leaves it unchanged for the second. It does
not delay. The reading holds only while all three of these hold:

1. **The deadline is a function of receipt alone.** `decisionDueBy` takes `receivedAt` and
   `priority` and nothing the agent produces. Referral does not restart, pause or extend
   it.
2. **The tool holds nothing.** Referral happens in the same exchange that received the
   request. There is no queue, retry loop or wait on the agent's side of it, and
   `prior_auth.elapsed_ms` is on the span so P1-F can budget it.
3. **The tool never asks for more information.** A request for additional documentation
   stops the clock in some regimes and is the delay a regulator would look for. Only the
   clinician in P3-E may send one. The agent's output type has no variant for it.

What would make the reading wrong is a regulator treating any referral a tool originates as
a delay "based in part on medical necessity". The resolution is then a change of policy,
not of code: the tool refers everything and approves nothing. That is one line in
`dispose`, and the evaluation suite would report it as an unnecessary-referral rate of 100%.

### The evaluation suite

`packages/eval-harness/datasets/prior-auth/`, 24 tasks, each with
`requires: { model: ['live', 'replay'] }` (P1-G). The stub model refers everything, so a
score earned on it describes the stub. `Task.input` is `unknown` (`types.ts:226`), so a task
holds a bundle reference and no harness type changes. `run-eval.ts` gains a `--suite` flag
that defaults to `memory-recall`. Graders:

| Grader              | Kind | Passes when                                                                    |
| ------------------- | ---- | ------------------------------------------------------------------------------ |
| `disposition_kind`  | code | the disposition's `kind` equals the label                                      |
| `no_false_approval` | code | a request labelled `refer-to-clinician` was not approved; vacuous otherwise    |
| `finding_agreement` | code | the share of criteria whose status matches the label is at least the threshold |
| `citations_resolve` | code | every cited id names a resource in the request bundle                          |

The report also prints two numbers across the suite. The **wrongful approval count** is the
sum of `no_false_approval` failures, and the only acceptable value is 0. The **unnecessary
referral rate** is the share of the eight approval-labelled requests that were referred. It
is reported rather than gated. It measures the reading of SB 1120 above, and a threshold on
it would be a policy choice this PRD has no basis to make.

**Recording** is one trial per task on model `live` / memory `live`, 24 `assess` calls. That
is more than the 20-request free-tier quota the index records (`docs/prd/README.md:29-30`).
So a free-tier recording takes two days or a paid key, and P1-C's nightly live tier would
spend its whole budget on this suite. The recorded set replays in the pull-request tier. As
P1-B says, a replayed `pass^k` is a frozen sample, and each task runs at most one replayed
trial.

### The detector: `scripts/lint-data.mjs`

It runs in `yarn lint:docs`, whose script gains `&& node scripts/lint-data.mjs`, so `ci.yml:25` gates it with no workflow change. P4-A puts
`lint-controls.mjs` on the same script, and whichever PRD lands second rebases the line. It
reports every problem before it exits, as `lint-docs.mjs:290-295` does.

It has two layers, because a code in a FHIR `Coding` and a number in a sentence need
different tests.

**Layer 1: payer data, structural, with no heuristics.** Payer data is every tracked `.json`
under the two roots above, plus any tracked `.json` anywhere whose top level has a
`resourceType`, so a FHIR fixture added elsewhere is still checked. For each file:

- D1. Every `Coding.system` is on the ADR 0008 allowlist. `http://www.ama-assn.org/go/cpt`
  fails by name, and an unknown system fails so that adding one is a decision a reviewer
  sees.
- D2. A code under the HCPCS Level II system
  (`http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets`, THO's preferred URI) matches
  `^[A-V][0-9]{4}$`. A five-digit code filed under HCPCS is HCPCS Level I, which is CPT.
- D3. A code under ICD-10-CM (`http://hl7.org/fhir/sid/icd-10-cm`) matches the ICD-10-CM
  shape.
- D4. No string value anywhere in the file matches `^[0-9]{5}$` or `^[0-9]{4}[FTU]$`, the
  shapes of Category I, II, III and PLA codes. Payer data has no postal codes (see above),
  so no legitimate field holds either shape.
- D5. The synthetic markers: `HTEST` on every resource, `example.org` identifier systems,
  NPI-shaped values that fail Luhn, digit-suffixed names, and 555-01xx telephones.

**Layer 2: every tracked text file, anchored.** `.yarn/` and `yarn.lock` are excluded
because they are vendored, and base64 values in cassettes are skipped because they are
encoded, not text.

- T1. A token of either code shape fails only when the same line contains `CPT`, `HCPCS` or
  `ama-assn` as a word, or when it is the value of a JSON key named `code`.
- T2. A US Social Security number shape (three digits, two, four, hyphenated) fails
  anywhere.

The false-positive strategy is to anchor, not to enumerate exclusions. The 21 bare matches
in Problem all fail T1's anchor. On 2026-09-26 the anchored rule, the JSON-`code` rule and
T2 each matched zero lines in the tracked tree. A ten-digit NPI pattern was considered for
layer 2 and rejected. Unix timestamps in seconds are also ten digits beginning with `1`,
and about one in ten passes a Luhn check, so the NPI rule stays in layer 1, where it applies
to fields declared as NPIs.

**The allowlist is for reasoned exceptions and it cannot rot.** `scripts/lint-data.allow.json`
holds `{ file, token, reason }` entries. An entry whose token no longer occurs in its file
fails the lint, the same "evidence must still exist" rule P4-A applies to anchors. The
expected number of entries at merge is zero.

**Tests do not commit what they detect.** `scripts/lint-data.test.mjs` (`node:test`) runs
the checker over fixtures in `scripts/__fixtures__/data/`, one per rule. Each violating
value is all zeros (`00000`, `0000F`, `0000T`, `0000U`), which has the shape of a code
without being one a reader could look up. Each fixture is written so that exactly one rule
fires, and the test asserts which rule. The fixtures are not excluded from the tree-wide
scan. They are allowlisted by entry, with a reason, which the no-rot rule keeps honest.

**What it does not do.** It cannot detect real PHI that looks synthetic, proprietary policy
text, or a name without digits in prose. Layer 1 proves the payer data is synthetic by
construction. Layer 2 catches the obvious shapes everywhere else. Everything else in ADR
0003's list stays a reviewer's job. That is why the control is split (see Risks).

**CTL-DATA-01.** With the detector merged, the control's evidence is a `test` anchor on
`lint-data.test.mjs` and a `ci` anchor on `ci.yml` job `ci`, run `yarn lint:docs`. Under
P4-A's rules that is `implemented` (`P4-A-controls-as-code.md:144`). Whichever of P3-D and
P4-A merges second moves the row.

### ADR 0008: the code systems this repository may contain

ADR 0003 names two permitted code systems and one forbidden one. D1 needs a complete list.
The rule is that the list holds what the dataset needs and nothing else. A system is added
only after a reviewer reads its licence.

| System                           | URI in `Coding.system`                                                                 | Decision   | Basis                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| ICD-10-CM                        | `http://hl7.org/fhir/sid/icd-10-cm`                                                    | permitted  | ADR 0003 decision 2. See the risk on its licence below                                                                   |
| HCPCS Level II                   | `http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets`                              | permitted  | ADR 0003 decision 2. THO's preferred URI; THO's retired `HCPCS-all-codes` URI is rejected, so D2 has one system to check |
| CMS Place of Service             | `https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code_Set` | permitted  | CMS publication; one of the two systems PAS admits for `item.location[x]`                                                |
| HL7 terminology (THO), FHIR core | `http://terminology.hl7.org/CodeSystem/*`, `http://hl7.org/fhir/*`                     | permitted  | HL7 publishes both for use in exchanges; `HTEST` and `process-priority` come from here                                   |
| Local synthetic                  | `https://example.org/*`                                                                | permitted  | RFC 2606 reserved domain; the fictional payer's own codes                                                                |
| CPT / HCPCS Level I              | `http://www.ama-assn.org/go/cpt`                                                       | forbidden  | ADR 0003 decision 2, restated                                                                                            |
| X12 code lists                   | `https://codesystem.x12.org/*`                                                         | forbidden  | "All X12 work products are copyrighted" (PAS value sets); X12 runs a licensing programme                                 |
| NUBC                             | `https://www.nubc.org/*`                                                               | forbidden  | AHA copyright; use in software "must be properly licensed" (PAS IP statement)                                            |
| SNOMED CT                        | `http://snomed.info/sct`                                                               | forbidden  | Free in the US under the UMLS licence; public redistribution not settled by NLM's text                                   |
| LOINC, RxNorm                    | —                                                                                      | not listed | Both are usable with notice or attribution, and the dataset needs neither. Adding one is an ADR 0008 amendment           |

ADR 0008 extends ADR 0003 and does not contradict it: CPT stays forbidden, ICD-10-CM and
HCPCS Level II stay permitted, and the three new forbidden entries are licensed content, the
boundary ADR 0003 draws. It does not supersede 0003.

## Acceptance criteria

Each criterion names the axis it is checked on where the model or the memory is involved.

**Dataset and detector**

- [ ] `packages/eval-harness/datasets/prior-auth/` holds 24 task files, 24 bundles under
      `bundles/`, and `bundles/labels.json`. The labels commit precedes the first cassette
      commit in `git log`.
- [x] `packages/prior-auth/data/policies/` holds four policies, one per HCPCS Level II code
      in the Design table, each with a `disclaimer` field.
- [x] `yarn lint:docs` runs `lint-data.mjs`, and it passes on the tree at merge with an
      empty `lint-data.allow.json` apart from the test fixtures' entries.
- [x] `scripts/lint-data.test.mjs` has one fixture per rule (D1-D5, T1, T2). Each fails
      with the named rule and no other. A clean fixture passes, and an allowlist entry whose
      token is absent fails.
- [x] A mutation is recorded in the pull request. A bundle's HCPCS code is replaced with
      `00000` and `yarn lint:docs` exits 1 naming D2 and D4. The mutation is then reverted.
- [ ] `fhir-validate.yml` passes with zero errors on base R4 and US Core 6.1.0 for all 24
      bundles and every captured response. The pinned validator, US Core and PAS versions
      are in the workflow file.
- [ ] The same job's PAS 2.2.1 report lists only errors on the X12-bound elements named in
      Design. A reviewer checks the job summary and finds no other error class.
- [x] ADR 0008 exists, is indexed in `docs/adr/README.md`, and names every system D1
      allows.
- [x] CTL-DATA-01 is `implemented` in `governance/controls.yaml` with the two anchors
      above, and the residual clause is a separate `procedural` control, in whichever of
      P3-D and P4-A merges second.

**HTTP surface.** Model `stub` / memory `stub` unless stated.

- [x] `main.ts` installs no global pipe. `RunsController`'s two `@Body()` parameters carry
      the `RunRequest` pipe, and `runs.e2e-spec.ts` no longer installs one. The existing
      `POST /runs` tests pass unchanged, including the `400` on an invalid body.
- [x] `POST /fhir/Claim/$submit` with `Content-Type: application/fhir+json` and a committed
      bundle returns `200` and a `Bundle` whose `entry[0]` is a `ClaimResponse`. The same
      bundle as `application/json` returns the same response.
- [x] A body that is not a `Bundle` returns `400` with an `OperationOutcome`. A `Bundle`
      whose first entry is not a `Claim` does the same.
- [x] On the stub model every committed bundle returns `outcome: queued`, and none
      returns an approval.
- [x] A unit test feeds `toClaimResponse` a cast `AdverseDetermination` and asserts that it
      throws. A second test drives both variants through the mapping and asserts that
      `outcome` is only ever `complete` or `queued`.
- [x] The sentinel test: a stub `assess` whose rationale contains a sentinel string
      produces a serialized response that does not contain it.
- [x] `GET /fhir/metadata` returns a `CapabilityStatement` listing exactly the operations
      implemented.

**Clock**

- [x] With the `Clock` fixed at `2026-03-01T10:00:00Z`, a standard request's
      `prior_auth.decision_due_by` span attribute is `2026-03-08T10:00:00Z` and an
      expedited request's is `2026-03-04T10:00:00Z`. `Claim.created` set a day earlier does
      not change either.
- [x] `clock.test-d.ts` asserts that `Parameters<typeof decisionDueBy>` is exactly
      `[Date, Priority]`, so nothing the agent produces can reach the deadline.

**Graph and agent.** Axes as stated per line.

- [x] Each of the four nodes emits an `agent.node.<name>` span, and a unit test asserts all
      four under one parent (memory `stub`).
- [x] `dispose` is a pure function with unit tests: all `met` with resolving citations gives
      approval; one `insufficient` gives a referral; a `met` whose only citation does not
      resolve gives a referral.
- [x] `SEAMS` includes `assess.criteria`. `EVAL_CASSETTE_MODE=replay yarn eval` on the
      memory-recall suite produces the same per-grader results as on `main`. Model
      `replay` / memory `live`.
- [ ] One recorded trial of each of the 24 tasks exists, recorded on model `live` / memory
      `live`, with the recording's git sha in each cassette header.
- [ ] `EVAL_CASSETTE_MODE=replay yarn eval --suite prior-auth` reports every grader for
      every task, the wrongful approval count, the unnecessary referral rate, and the labels'
      sha256. Model `replay` / memory `live`. The wrongful approval count is 0. The recorded
      values of the other numbers are written into `docs/STATUS.md`, whatever they are.
- [x] On model `stub`, the prior-auth suite skips all 24 tasks and says so beside the rate
      (P1-G).

**Bookkeeping**

- [x] `docs/STATUS.md` has a row for the prior-authorization surface citing the service
      spec, and P3-A's clinician-gate row moves from `stubbed` to `implemented`, citing the
      prior-auth graph test in which a disposition is produced and gated.
- [x] No file added by this PRD contains a CPT code, a real NPI, or a resource without
      `HTEST`. `lint-data.mjs` checks this. It is not self-reported.
- [x] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## What shipped, and where it diverged

_Recorded 2026-10-08, on the branch for #84._ Every ticked criterion was verified on the
stub and fixture axes, or with throwaway stores on model `replay` / memory `live`. No
`generateContent` call was made: the free tier's daily quota was spent by other work that
day, so the recording is the one step left (see "The recording").

**The licence research came first, and neither answer was restrictive.** Both narrowed ADR
0003, and ADR 0008 records them with sources read on 2026-10-08. ICD-10-CM has no licence of
its own. WHO's licensing FAQ sends anyone asking about the US modification to NCHS, NCHS
publishes none, and the FY2026 and FY2027 release files carry no notice. CDC's agency
policy governs: public domain, on four conditions (attribution, no implied endorsement, no
substantive change, a statement that the material is free on the agency's website). ADR
0008 and `data/payer.json` carry the notice that meets them. HCPCS Level II is a CMS work,
and CMS claims no copyright in it except the D range, which its own record layout says is
the ADA's CDT. So D2 checks `^[A-CE-V][0-9]{4}$`, not P3-D's `^[A-V][0-9]{4}$`. ADR 0003 is
not superseded. Its decision stands, and its premise that every Level II code is free was
wrong for one letter.

**The validator rejected the NPI design.** US Core 6.1.0's invariant `us-core-17` requires
a valid NPI check digit. An NPI built to fail the check breaks the profile the job gates on,
and one that passes could belong to a real provider. US Core requires an identifier, not
an NPI, so the practitioner and the supplier carry `https://example.org/` identifiers and
the bundles hold no NPI. `lint-data.mjs` keeps the check-digit rule, so between the two
checks an NPI cannot enter payer data in either form.

**Other validator findings.**

- The validator rejects `https://example.org/` URLs as not for production data. The job
  passes `-allow-example-urls true`, because RFC 2606 reserves the domain for this purpose.
- An unversioned `meta.profile` resolved to US Core 7.0.0 once PAS was loaded, because PAS
  2.2.1 depends on 7.0.0. Each profile now names `|6.1.0`.
- Three PAS requirements are not X12, so the bundles carry them: the
  `careTeamClaimScope` extension, a `PractitionerRole` on the care team, and
  `Coverage.subscriber`. The last is there because PAS's `self-beneficiary` invariant
  reads "self" in X12's code list.
- After those changes the PAS report has 0 errors outside the expected classes. The
  approval response conforms to the PAS response bundle outright. The queued response
  fails only on `outcome`. The expected classes are `requestType`, `certificationType`,
  `item.category`, `queued` in place of X12's `A4`, and two classes that follow from those:
  the claim-update branch and the summary of no profile matching.

**Types.** P3-D sketched each FHIR schema with `satisfies z.ZodType<fhir4.X>`. A nested
passthrough schema's inferred type is too large for `tsc` to write into a declaration file
(TS7056). So each schema is annotated `z.ZodType<…>` instead. That is the same
assignability check, shown by mutating `servicedDate` to a number, and the exported types
are base R4's own. `@types/fhir` is a dependency rather than a devDependency, because the
emitted declarations name it.

**Other divergences.**

- **The administrative stratum makes no model call.** `lookup` refers a request whose
  coverage is inactive, and `assess` is skipped. Its labels are `assessed: false`, and
  `finding_agreement` passes on it only if nothing was assessed. A trial set therefore
  costs 20 `assess` calls, not the 24 that Design counted.
- **`toClaimResponse` takes `Policy | undefined` and a context** carrying `respondedAt`,
  the case id (for `identifier` and `preAuthRef`) and the referral reason. A code with no
  policy is referred, not rejected.
- **`yarn eval --suite prior-auth` cannot reach the script**, because Turbo reads the flag
  as its own. The suite is `EVAL_SUITE=prior-auth`, which is declared in `turbo.json`.
  `--suite` works when the script is run directly. The suite defaults to one trial a task.
- **The bundles are generated from `scenarios.ts`**, where every note is plain text a
  reviewer can read. The scenarios were still written against the stratum table by hand,
  and `dataset.test.ts` holds the committed files to that source byte for byte.
- **`lint-data.mjs` also decodes plain-text attachments** and applies D4 to the note text,
  so a code inside base64 cannot pass unseen. The planned mutation names T1 as well as D2
  and D4, because a code-shaped value under a JSON `code` key is T1's anchor.
- **CTL-DATA-01 has no `test` anchor.** P4-A's resolver requires the test file to sit in a
  workspace with a `test:<tier>` script. The root scripts' `node:test` files run inside
  `yarn lint:docs`, so the `ci` anchor on that step is the executable evidence.
- **One JSON parser for both media types.** Nest registers its default `jsonParser` only
  when no middleware of that name is applied. A second `express.json` for FHIR alone would
  have stopped `application/json` being parsed. `configureApp` is called by `main.ts` and
  the spec. A body the parser rejects never reaches the FHIR controller, so the global
  filter writes an `OperationOutcome` for `/fhir/` paths.
- **The fictional payer is P2-B's Quillmark Health Partners.** P2-B landed first and
  picked the names. Its corpus gives Quillmark a Medicare Advantage plan, Quillmark Senior
  Advantage, and P3-D's timeframes bind Medicare Advantage and exclude exchange plans. So
  the two plans here are Quillmark Senior Advantage and a Plus variant.
- **The policy thresholds are deliberately not real figures**: an AHI of 18, a 21-day
  trial, a 60-day home assessment and 35 degrees of head elevation. They cannot be
  mistaken for an LCD's.

**The mutation, recorded 2026-10-08.** `E0601` in
`pa-e0601-all-met-structured.bundle.json` was replaced with `00000`. `yarn lint:docs` exited
1, naming D2, D4 and T1 against that file, and the change was reverted.

**The recording.** It needs model `live` and memory `live`, because the cassette header
pins both. That means a key and the two stores. Run it from a clean tree at the branch
head, because the header records the sha:

```
EVAL_SUITE=prior-auth EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 \
  EVAL_EXPECT_AXES='model=live memory=live' EVAL_TASKS=<one day's ids> yarn eval
```

The whole set makes 20 `generateContent` calls: one `assess.criteria` call for each request
that is not administrative. It makes no embedding call. An `AssessmentFormatError` retry
adds one call each time it fires. The free tier allows exactly 20 calls a day and 5 a
minute. The client waits out a per-minute 429, but a single retry would exhaust the day.
So the plan is two batches of 10, using the `EVAL_TASKS` filter P1-E added. Day 1 is the
twelve E0601 and E0470 tasks, ten of which call the model. Day 2 is the twelve K0823 and
E0260 tasks. Afterwards, run
`EVAL_SUITE=prior-auth EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval` to write
`datasets/prior-auth/baselines/replay.json`. Commit the 24 cassettes and the baseline, add
a prior-auth replay step to `agent-eval.yml`, and write the recorded figures into STATUS
row 26.

**Open criteria.**

- **The labels commit precedes the first cassette commit.** The labels have a commit of
  their own, "label the prior-authorization requests", but no cassette commit exists yet,
  so the ordering cannot be read from `git log`. It closes with the recording.
- **One recorded trial of each task, and the replayed report with its four figures.**
  These wait for the recording above. The replay path is built: on model `stub` all 24
  tasks are skipped and each figure says "not measured". With no cassettes, a replay aborts
  and names the first task that has none.
- **`fhir-validate.yml` passes, and its PAS report lists only X12-bound errors.** Both
  were verified locally with the pinned validator 6.10.4 in a Java 17 container. The run
  covered the 24 bundles and 27 captured responses: 51 files, 0 gated errors, 0 `other`.
  Each criterion is ticked only once the workflow has run on the pull request.

## Risks and open questions

- **Open, and it changes scope: may the repository hold X12 code values?** Everything
  under "What is claimed" follows from treating X12 like CPT. If the review decides a
  handful of X12 code values in fixtures is acceptable use, the `Claim` needs three X12
  codes per item and the `ClaimResponse` one. PAS profile validation then moves from
  reported to gated, and the claim becomes "PAS 2.2.1 request and response profiles".
  Server conformance would still need subscriptions, which is P3-E. The decision belongs in
  ADR 0008 whichever way it goes, and this draft recommends against it: the repository's
  boundary is licensed content, and X12 says its work products are copyrighted.
  **Decided at review, 2026-09-26: no X12 code values.** The claim stays "shaped after
  PAS 2.2.1".
- **The size is L only after a split.** The whole of what P3-A handed over is intake,
  review, inquiry, appeals and the clock. Built at once, that is three to four weeks. This
  PRD is the intake half. Its estimate is about three days for the dataset and labels, two
  for the detector and ADR, two to three for the FHIR schemas and the validator job, two to
  three for the graph, seam and recording, and one to two each for the surface and the
  suite. That is eleven to fifteen days, at the top of L. None of this code has run, and
  the validator job is the unknown most likely to grow: a profile that fails on slicing
  may need the bundles reshaped. **Proposed follow-on: P3-E, "Clinician review queue,
  `$inquire` and the decision clock"**, size M. It covers the pended lifecycle through
  LangGraph `interrupt()` on this PRD's checkpoint (available at the pinned 0.4.10), the
  clinician route that calls `attestAdverseDetermination`, `Claim/$inquire`, overdue
  detection against `decisionDueBy`, and appeals. It is not in the index. If the split is
  accepted, the row and the P3-D → P3-E edge are added and the Non-goals above point at a
  real id. If it is rejected, this PRD is not L. **Decided at review, 2026-09-26: split
  accepted.** P3-E is in the index as a draft with the P3-D → P3-E edge.
- **P3-A's channel is on the chat graph, and the producer is not.** P3-A adds `disposition`
  to the chat graph's state and to `RunResponse` (`P3-A-clinician-gate.md:271-276`). This
  PRD produces a disposition on a second graph and returns it as FHIR, so P3-A's channel
  keeps no producer. The types, the `Node` alias and the lint rule carry over unchanged.
  The open question is whether P3-A, still unimplemented, should keep that channel at all.
  That changes P3-A's scope, not this PRD's. **Decided at review, 2026-09-26: it does not.**
  The `disposition` channel and the `RunResponse` field move to this PRD's graph and FHIR
  mapping; P3-A keeps the package, the `Node` alias, the lint rule, the type tests and the
  strict egress parse, and its type tests run against a fixture state. P3-A records the
  amendment.
- **Splitting CTL-DATA-01.** P4-A's rules have no partial status. The detector enforces CPT
  and synthetic identifiers in payer data. It cannot enforce "no proprietary payer content"
  or real PHI outside payer data. Marking the whole row `implemented` would be the ticked
  box with a caveat that `.agents/prd-author.md` forbids. So this PRD proposes that
  CTL-DATA-01 narrows to what the detector checks and a new CTL-DATA-02 keeps the rest as
  `procedural`. That edits P4-A's catalogue, which is accepted and not shipped. **Decided
  at review, 2026-09-26: split**, made in this PRD's implementation against whatever
  `governance/controls.yaml` holds by then.
- **The SB 1120 reading is a portfolio's, not counsel's.** It is stated as a reading with
  the invariants it rests on, and the fallback is a one-line policy change. Neither DMHC nor
  CDI guidance defines "delay". If either does, the reading is revisited against the text.
- **The dataset could be too easy.** Hand-authored strata are constructed toward an answer,
  which is P2-B's point about synthetic sets (`P2-B-retrieval-ablation.md:264-268`). Two
  defences are built in. The `all-met-narrative` and `ambiguous` strata exist so that
  keyword matching does not pass, and the per-stratum results are printed beside the
  headline. If a live model scores 24/24 on the first recording, the strata are too easy,
  and that is a finding to report, not a pass.
- **Twenty-four is small.** A wrongful-approval count of 0 over 16 opportunities says
  little about the rate, and the report prints the denominator beside the count. The size
  is set by the recording quota. P1-D's statistical gate is where a larger set would earn
  its keep.
- **The ICD-10-CM and HCPCS Level II licences are asserted, not cited.** ADR 0003 calls
  both "freely redistributable" (`0003-...md:32-33`). This draft found no primary-source
  statement to that effect for either. CMS publishes the HCPCS files and the pages read say
  nothing about a licence, and the Design table's short descriptors rest on the same
  assumption. WHO holds the ICD-10 copyright, and its licensing FAQ tells users of national
  modifications to contact the modifying authority, which is NCHS for ICD-10-CM. HL7's own
  guides use ICD-10-CM codes in published examples, and CDC distributes the files at no
  cost. Neither of those is a licence. ADR 0008 has to cite an NCHS or CMS statement, or
  narrow the permission to what one says. If the answer is restrictive, ADR 0003 is wrong,
  and so are the diagnoses and service codes in this dataset. That research is the first
  task of the implementation, before any dataset file is written.
- **CMS-0057-F's dates could move.** As of CMS's rule page modified 2026-08-31, no 2026
  rule has changed the 2027-01-01 API date or the 2026-01-01 timeframes. Reports of
  enforcement deferral are secondary and unconfirmed. `decisionDueBy` encodes the
  timeframes, not the API date, so a deferral changes a sentence in Why it matters and no
  code.

## References

Every external source below was read on 2026-09-26.

- HL7 Da Vinci Prior Authorization Support (PAS) IG 2.2.1, STU 2, 2026-03-27,
  <https://hl7.org/fhir/us/davinci-pas/2.2.1/en/>. Also cited: `specification.html`
  (§spec-51, §spec-55, §spec-56, the review-action rules), `usecases.html` (§use-2), and
  `StructureDefinition-profile-claim.json` together with the `extension-certificationType`
  and `extension-serviceItemRequestType` definitions for the X12 bindings. Package list:
  <https://hl7.org/fhir/us/davinci-pas/package-list.json>
- Da Vinci CRD 2.2.1 and DTR 2.2.0, both 2026-03-27: <https://hl7.org/fhir/us/davinci-crd/>,
  <https://hl7.org/fhir/us/davinci-dtr/>
- CMS Interoperability and Prior Authorization Final Rule, CMS-0057-F, 89 FR 8758
  (2024-02-08), <https://www.govinfo.gov/content/pkg/FR-2024-02-08/pdf/2024-00895.pdf>. That
  covers 42 CFR 422.122, 422.568(b)(1)(ii), 422.572(a), 431.80, 440.230(e)(1), 457.732, and
  Table H3 at 8945
- CMS, APIs: relevant standards and implementation guides (modified 2026-08-31),
  <https://www.cms.gov/priorities/burden-reduction/overview/interoperability/implementation-guides-standards/application-programming-interfaces-apis-relevant-standards-implementation-guides-igs>
- CMS, HIPAA transaction enforcement discretion for the X12 278 (letter of 2024-02-28),
  <https://www.cms.gov/priorities/burden-reduction/overview/interoperability/frequently-asked-questions/hipaa-transaction-enforcement-discretion>
- California SB 1120 (Stats. 2024, ch. 879), Health & Safety Code § 1367.01(k),
  <https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB1120>
- California Department of Insurance, Guidance SB 1120:1, 2025-05-05,
  <https://www.insurance.ca.gov/0250-insurers/0500-legal-info/0200-regulations/HealthGuidance/upload/SB-1120-1-Guidance-Use-of-Artificial-Intelligence-Algorithms-and-Other-Software-Tools-in-Utilization-Management.pdf>
- HL7 Terminology (THO): `v3-ActReason` (`HTEST`, v7.4.0) at
  <https://terminology.hl7.org/CodeSystem-v3-ActReason.html>, and the `hcpcs-Level-II`
  NamingSystem at <https://terminology.hl7.org/NamingSystem-hcpcs-Level-II.html>
- NLM Clinical Tables, HCPCS and ICD-10-CM lookups, used to check each code in the Design
  table: <https://clinicaltables.nlm.nih.gov/>
- Synthea, <https://github.com/synthetichealth/synthea>: Apache-2.0, v4.0.0, and issue #403
  on CPT and ICD-10
- NLM, SNOMED CT licensing, <https://www.nlm.nih.gov/healthit/snomedct/snomed_licensing.html>.
  RxNorm terms of service,
  <https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html>
- WHO, FAQ on licensing ICD-10,
  <https://cdn.who.int/media/docs/default-source/publishing-policies/copyright/who-faq-licensing-icd-10.pdf>
- HL7 FHIR Validator, `validator_cli.jar` 6.10.4,
  <https://github.com/hapifhir/org.hl7.fhir.core/releases>
- `@types/fhir` 0.0.44, `fhir-zod` 1.0.0, `@medplum/core` 5.1.41 on npm
- Inferno Da Vinci PAS test kit v0.15.2, <https://github.com/inferno-framework/davinci-pas-test-kit>
- RFC 2606, reserved top-level DNS names (`example.org`)
- `docs/adr/0003-payer-domain-with-licensing-and-phi-as-the-boundary.md`,
  `docs/prd/P3-A-clinician-gate.md`, `docs/prd/P4-A-controls-as-code.md`,
  `docs/prd/P2-B-retrieval-ablation.md`
