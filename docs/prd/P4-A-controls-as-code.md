---
id: P4-A
title: governance/controls.yaml and a CI check for unmapped controls
tier: 4
status: draft
size: M
depends_on: []
blocks: []
issue: null
superseded_by: null
---

# P4-A · `governance/controls.yaml` and a CI check for unmapped controls

## Problem

The repository has safeguards that correspond to named clauses in AI-governance and
security frameworks, and nothing records the correspondence. Outside this backlog, no
tracked file mentions NIST, ISO/IEC 42001, OWASP or HIPAA. The only framework name in
the repository is the P4-B row title at `docs/prd/README.md:142`. A reader who wants to
know which safeguards exist, and what backs each one, has to rebuild the list from ADRs,
tests and workflows.

Some of the safeguards exist and run. `security.yml:16-59` fails a pull request on a
high or critical advisory and re-audits every Monday. `cassette-secrets.test.ts:47`
asserts that the committed cassette set contains no Google API key. `extraction.ts:35`
schema-validates model output before `reflect` can write it. Others are only prose.
ADR 0003 forbids real PHI and CPT codes (`0003-...md:38-58`), and its own consequences
section says that "should eventually be enforced" and that until then it "lives in
`.agents/reviewer.md` as a rule a reviewer applies by hand" (`0003-...md:71-73`). The
single memory write path is a rule in `CLAUDE.md:8-10` and `.agents/reviewer.md:18`,
and nothing checks it. Code that is wired in but untested also exists:
`AuditInterceptor` is registered globally (`app.module.ts:12`), and no test references
it. Nothing distinguishes these three kinds of backing.

The repository already has the pattern this needs: `docs/STATUS.md` is "claim → evidence
at file:line", and `scripts/lint-docs.mjs` checks it. The pattern cannot be copied as it
is, because the evidence it checks goes stale without the check failing.
`lint-docs.mjs:206-212` confirms that the cited file exists and that the cited line is
no greater than the file's length. It does not confirm that the line still holds the
thing the sentence names. At HEAD `yarn lint:docs` passes (run on this branch), and:

- `docs/STATUS.md:47` (row 17) cites `runs.service.ts:190` as the stub `selectTool`
  returning `null`. Line 190 is `pgvectorWriter: this.pgvectorWriter ?? stubPgvectorWriter,`,
  and the stub is at `runs.service.ts:264`. The same row cites `harness.ts:93` for the
  refusal before the first trial. Line 93 is inside a doc comment, and the
  `assertAxesSatisfy` call is at `harness.ts:120`. Both citations were accurate at
  `abc2707` (P1-G). They moved in `4516f4e` (#51), which edited `runs.service.ts`,
  `harness.ts` and `docs/STATUS.md` in the same pull request.
- `docs/STATUS.md:33` (row 3) cites `graph/graph.test.ts:108` for "a 4xx is not retried".
  Line 108 is inside the test that retries a failing node. The client-error test is
  `'does not retry a client error'` at `graph.test.ts:129`.
- `docs/STATUS.md:41` (row 11) cites `nodes/ingress.node.ts:16` as where ingress throws
  on a parse failure. Line 16 is blank. `RunRequestSchema.parse` is at line 15.

A catalogue that cited evidence this way would drift the same way while its CI check
stayed green, so its anchor format has to be designed rather than copied.

## Why it matters

Every AI-governance standard this repository could be read against asks for the same
artifact: a list of controls, a statement of whether each one applies, and the evidence
behind it. ISO/IEC 42001:2023 clause 6.1.3 requires a Statement of Applicability that
justifies each Annex A control's inclusion or exclusion. NIST AI RMF 1.0 asks that "the
risks or trustworthiness characteristics that will not – or cannot – be measured are
properly documented" (MEASURE 1.1), and that the risk process be "established through
transparent policies, procedures, and other controls" (GOVERN 1.4). In most organizations
that artifact is a spreadsheet, and its evidence column goes stale unnoticed. Keeping it
as code — one file, validated, with every evidence pointer resolved by CI — makes this
repository an example of the practice rather than a description of it. The same rule
already governs `docs/STATUS.md`: a claim either resolves at HEAD or fails the build. P4-A
extends that rule from capability claims to control claims, and fixes the one way the
existing check can pass while its evidence has gone stale.

## Scope

- `governance/controls.yaml`: a framework registry and a catalogue of 18 controls (listed
  under Design), each with a status, clause mappings, and evidence anchors.
- `scripts/lint-controls.mjs`: validates the catalogue against a Zod schema, resolves
  every evidence anchor against the tracked tree, and cross-checks PRD frontmatter. It runs
  as part of `yarn lint:docs`, so the existing `ci.yml:25` step gates it and no workflow
  changes.
- `scripts/lib/frontmatter.mjs`: the frontmatter reader from `lint-docs.mjs:38-59`, moved
  out so both scripts use one parser.
- `governance/CONTROLS.md`: a Markdown matrix generated from the catalogue. It is checked
  in so a reviewer can read it on GitHub, and the lint fails when it is stale.
- `scripts/lint-controls.test.mjs` (`node:test`) with fixture catalogues under
  `scripts/__fixtures__/controls/`, one per failure mode. It is run by `yarn lint:docs`.
- `zod` and `yaml` added to the root `devDependencies`. Both are already in the lockfile
  (`yarn.lock:10618` and `yarn.lock:10571`), so this adds no new package to the tree.
- An optional `controls: []` frontmatter field for PRDs, documented in
  `docs/prd/_TEMPLATE.md`. `.agents/prd-author.md` and `.agents/reviewer.md` each get one
  rule. `.context/conventions.md` (Documentation) and `.context/workflows.md` (a new "Add
  or change a control" entry) are updated.

### Non-goals

- **Moving `docs/STATUS.md` onto symbol anchors.** The three stale rows above get their
  line numbers corrected in the P4-A pull request. That is a three-line fix, needed
  whatever else happens. Replacing `STATUS.md`'s `file:line` form with the resolver this
  PRD builds is a larger decision about a file other PRDs edit weekly. **No PRD owns it.**
  The first open question below asks whether it should be folded in here.
- **An automated CPT / PHI detector.** ADR 0003 names the check it wants and leaves it
  unowned. A five-digit CPT pattern collides with ports, ZIP codes, timestamps and
  version numbers, so it needs its own false-positive design. Until it exists,
  `CTL-DATA-01` is `procedural`, and the matrix shows that. **No PRD owns it.** The third
  open question asks whether to give it an id.
- **Framework coverage.** The check asserts that every catalogued control has evidence.
  It does not assert that every clause of a framework has a control, and the matrix says
  how much of each framework is not assessed. Most of NIST AI RMF GOVERN 2–6 concerns
  organizational roles, training and workforce diversity, which a code repository cannot
  evidence.
- **OSCAL.** NIST's Open Security Controls Assessment Language is the standard
  machine-readable control format. It was considered and not used. It has no official
  NIST catalog for AI RMF 1.0, AI 600-1, ISO/IEC 42001 or either OWASP list; the one
  public AI RMF catalog is community-contributed and "not endorsed by NIST". A
  component-definition document for 18 controls would be larger than the checker. If a
  consumer ever needs OSCAL, an exporter from `controls.yaml` is a separable follow-on.
- **Filling the planned controls.** Each `planned` row names the PRD that delivers it —
  P1-C, P1-F, P2-C, P3-A, P3-C, P4-B, P4-C — and moves to `implemented` in that PRD's
  pull request.

## Design

### Anchors that resolve, not line numbers

The schema rejects a `:NN` anchor anywhere in `governance/`. Evidence is one of four
kinds. Each kind resolves by searching the file's text, so it keeps resolving when the
lines above it move, and it breaks when the named thing is renamed or removed:

| Kind     | Fields                    | Resolves when                                                                                                                                                                                                                                        |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `symbol` | `file`, `name`            | `file` is tracked (exact path — not the suffix match at `lint-docs.mjs:194`, which allows two files with the same name) and exactly one line declares `name` as a `function`, `class`, `const`, `let`, `interface`, `type` or `enum`                 |
| `test`   | `file`, `name`, `tier`    | exactly one `it(`, `test(` or `describe(` call in `file` has `name` as its title, and it is not a `.skip` or `.todo` call. The file's workspace declares a `test:<tier>` script, and a workflow triggered on `pull_request` runs `turbo test:<tier>` |
| `ci`     | `workflow`, `job`, `run?` | `.github/workflows/<workflow>` parses, `jobs.<job>` exists, and when `run` is given, one of the job's steps has a `run:` containing it. The matrix prints the workflow's triggers, so a nightly-only job is not mistaken for a gate                  |
| `doc`    | `file`, `heading`         | `file` is tracked Markdown and contains a heading whose text is exactly `heading`                                                                                                                                                                    |

Line numbers do not appear in the generated matrix either. Every line shift in a cited
file would make the matrix stale, and the lint would then fail unrelated pull requests
until someone regenerated it. The matrix links to the file and names the symbol or the
test instead.

### Status carries the kind of backing

| Status           | Requires                                                                                        | Means                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `implemented`    | ≥1 `test` or `ci` anchor, all anchors resolving                                                 | Something executable fails if the control stops holding                  |
| `procedural`     | ≥1 `doc` anchor, no executable anchor                                                           | Enforced by a person applying a written rule                             |
| `planned`        | `owner`: a PRD id in the index whose status is not `shipped`; anchors optional but must resolve | Not delivered; the owner is the PRD that delivers it                     |
| `not-applicable` | `rationale` of at least 40 characters; no `owner`                                               | Excluded, with the justification ISO/IEC 42001 6.1.3 requires for an SoA |

This follows `docs/STATUS.md`, where `stubbed` exists because "a class with a clean
interface … that no request path ever constructs" was the gap that produced that file.
`procedural` is this file's version of that row: a written rule and a checked rule are
not shown as the same thing. `AuditInterceptor` is the example of what the `implemented`
rule excludes. It is wired in (`app.module.ts:12`) and has no test, so a symbol anchor
alone cannot make it `implemented`, and it is not catalogued on its own. P3-C's ledger
covers the audit record.

### The file

```yaml
# governance/controls.yaml
frameworks:
  nist-ai-rmf-1.0:
    title: NIST AI 100-1, Artificial Intelligence Risk Management Framework (AI RMF 1.0)
    published: 2023-01
    url: https://doi.org/10.6028/NIST.AI.100-1
    size: 72 # subcategories, so the matrix can say how many are not assessed
    clauses:
      MEASURE 2.3: AI system performance or assurance criteria are measured …
      # only the clauses the catalogue maps, copied from the source
  owasp-llm-2025:
    title: OWASP Top 10 for LLM Applications 2025
    url: https://genai.owasp.org/llm-top-10/
    size: 10
    clauses:
      LLM03:2025: Supply Chain
  # …

controls:
  - id: CTL-SUP-01
    title: A high or critical dependency advisory fails the pull request, and is re-checked weekly
    status: implemented
    maps:
      - { framework: owasp-llm-2025, ref: 'LLM03:2025' }
      - { framework: owasp-asi-2026, ref: ASI04 }
      - { framework: nist-ai-600-1, ref: MS-2.7-001 }
      - { framework: nist-ai-rmf-1.0, ref: MANAGE 3.1 }
    evidence:
      - { kind: ci, workflow: security.yml, job: dependency-audit, run: yarn npm audit }

  - id: CTL-HUM-01
    title: No adverse determination is issued without a licensed clinician
    status: planned
    owner: P3-A
    maps:
      - { framework: nist-ai-rmf-1.0, ref: MAP 3.5 }
      - { framework: owasp-asi-2026, ref: ASI09 }
```

The Zod schema lives in `scripts/lint-controls.mjs`. `.context/conventions.md:6-7`
makes Zod the source of truth, and this follows it. There is no JSON Schema file. The
pinned `zod@^3.24` has no JSON Schema emitter, so providing one would take a second
dependency (`zod-to-json-schema`) and create a second schema to keep in step, all for
editor autocompletion.

```js
const Evidence = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('symbol'),
    file: RepoPath,
    name: z.string().regex(/^[A-Za-z_$][\w$]*$/),
  }),
  z.object({
    kind: z.literal('test'),
    file: RepoPath,
    name: z.string().min(1),
    tier: z.enum(['unit', 'service', 'integration', 'e2e']),
  }),
  z.object({
    kind: z.literal('ci'),
    workflow: z.string().regex(/^[\w-]+\.ya?ml$/),
    job: z.string(),
    run: z.string().optional(),
  }),
  z.object({ kind: z.literal('doc'), file: RepoPath.regex(/\.md$/), heading: z.string().min(1) }),
]);
// RepoPath rejects /:\d+/ with the message "line anchors rot — name a symbol, a test or a heading".
```

A `ref` must be a key of its framework's `clauses` map, so a typo such as `MEASURE 2.14`
fails unless someone also adds it to the registry, where a reviewer sees it. A new version
of a framework gets a new framework id rather than an edit to an existing one, so a
control's mapping is never rewritten under it.

### The checks

`scripts/lint-controls.mjs` reports every problem it finds before it exits, not only the
first, as `lint-docs.mjs:290-295` does. Grouped by the three failure modes in the P4-A
brief:

- **(a) A control with no backing.** It fails the schema, or it fails the status rules
  above. That covers a missing `owner` on `planned`, a missing `rationale` on
  `not-applicable`, and an `implemented` control whose only anchors are `symbol` or
  `doc`.
- **(b) Evidence that no longer exists.** Any anchor that does not resolve under the table
  above. That includes a test title that is now `it.skip`, and a `ci` anchor whose `run`
  substring is gone from the job.
- **(c) PRDs and the catalogue disagree.** Any PRD whose `controls:` frontmatter names an id
  the catalogue lacks, in any status. A `planned` control whose `owner` is `shipped` in the
  index: the PRD delivered and the row did not move. A `shipped` PRD that lists a control
  still `planned`. A `planned` control whose owner has a PRD file that does not list it:
  the same symmetry `lint-docs.mjs:141-151` enforces for `depends_on`/`blocks`, and
  checkable only where the file exists.

`controls:` is only added to PRDs that are not yet shipped. `.agents/prd-author.md` says
never to edit a `shipped` PRD to describe what was built, and back-filling a shipped
record with the controls it turned out to deliver is that. The evidence for shipped
work points at code, not at the PRD.

With `--write` the script renders `governance/CONTROLS.md` through Prettier's API (root
`devDependencies` already has `prettier`), so the generated file passes
`yarn format:check`. The file has one row per control: id, title, status, mapped clauses,
evidence, and owner or rationale. It has one section per framework listing the clauses
referenced, and one line per framework giving how many clauses are not assessed. Without
`--write` the script renders in memory, compares, and fails with
`governance/CONTROLS.md is stale — run yarn controls:matrix`.

`package.json` becomes:

```json
"lint:docs": "node scripts/lint-docs.mjs && node scripts/lint-controls.mjs && node --test scripts/",
"controls:matrix": "node scripts/lint-controls.mjs --write"
```

`lint-docs.mjs` needs nothing installed today: its only imports are `node:` builtins
(`lint-docs.mjs:11-14`). `lint-controls.mjs` needs `zod` and `yaml`, so after this
change `yarn lint:docs` needs a `yarn install` first. CI already runs one
(`ci.yml:23`). The alternative was a `packages/governance` workspace: TypeScript, and
typecheck and lint through Turbo, at the cost of a build step in front of a doc lint.
It was rejected because `scripts/` is where this repository keeps its checks.

### The initial catalogue

Eighteen controls. The bar for a row: the control maps to a named clause, **and** either
this repository evidences it today or a PRD in the index is scoped to deliver it.
Generic application hygiene with no clause to map to is left out, even where the code
exists. `ZodValidationPipe` on the request body (`main.ts:25`) is correct, and it is not
a control any of these frameworks name.

| Id          | Control                                                                               | Status           | Maps to                                                            | Evidence or owner                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTL-EVAL-01 | Agent capability and reliability are measured over repeated trials (pass@k, pass^k)   | `implemented`    | RMF MEASURE 2.3, MEASURE 2.5; 600-1 MS-2.5-001; 42001 A.6.2.4      | `EvalHarness` (`harness.ts:96`); test `'reports pass@k as capability and pass^k as reliability'` (`harness.test.ts:94`, unit)                                                                                                                                                                                       |
| CTL-EVAL-02 | A task the run's axes cannot measure is excluded and named beside the rate            | `implemented`    | RMF MEASURE 1.1; 42001 A.6.2.4                                     | `skippedTasks` (`axes.ts:142`); test `'computes passRate over the tasks that ran, and says which did not'` (`harness.test.ts:157`, unit)                                                                                                                                                                            |
| CTL-EVAL-03 | Agent evaluation runs on every pull request and can block it                          | `planned`        | RMF MANAGE 1.1, MEASURE 2.3; 42001 A.6.2.5                         | P1-C. Today `agent-eval.yml:3-6` is schedule and manual only, and its `test:eval` step (`:47`) does not invoke the agent (`docs/prd/README.md:100-102`)                                                                                                                                                             |
| CTL-OUT-01  | Model output is schema-validated before it can reach memory                           | `implemented`    | OWASP LLM05:2025; ASI06                                            | `parseExtraction` (`extraction.ts:35`); test `'throws when the JSON parses but does not match the schema'` (`extraction.test.ts:32`, unit)                                                                                                                                                                          |
| CTL-SEC-01  | Committed model recordings carry no credential                                        | `implemented`    | OWASP LLM02:2025; RMF MEASURE 2.7                                  | `redactString` (`redact.ts:21`); test `'carries no Google API key'` (`cassette-secrets.test.ts:47`, unit)                                                                                                                                                                                                           |
| CTL-SUP-01  | A high or critical dependency advisory fails the pull request; re-audited weekly      | `implemented`    | OWASP LLM03:2025; ASI04; 600-1 MS-2.7-001; RMF MANAGE 3.1          | `security.yml` job `dependency-audit` (`:16`), triggers `pull_request`, `push`, weekly `schedule` (`:3-10`)                                                                                                                                                                                                         |
| CTL-RES-01  | A failing I/O node is retried under a bound; a client error is not; a run fails whole | `implemented`    | RMF MEASURE 2.6; ASI08                                             | `IO_RETRY` (`retry.ts:27`); tests `'retries an I/O node that fails twice and succeeds on the third attempt'` (`graph.test.ts:100`), `'does not retry a client error'` (`:129`), unit; `'emits a terminal error frame and closes the stream'` (`runs.e2e-spec.ts:175`, service)                                      |
| CTL-LOG-01  | Graph nodes and store operations are traced as nested spans                           | `implemented`    | 42001 A.6.2.8; RMF GOVERN 4.3                                      | tests `'nests the retrieval store spans under agent.node.retrieve'` (`spans.test.ts:114`) and `'nests the write spans under agent.node.reflect'` (`:119`), unit                                                                                                                                                     |
| CTL-DOC-01  | Capability claims carry evidence that CI resolves                                     | `implemented`    | 42001 A.6.2.7; RMF GOVERN 1.4                                      | `ci.yml` job `ci`, run `yarn lint:docs` (`:25`). What this proves is the weaker thing described in Problem, and the matrix row says so                                                                                                                                                                              |
| CTL-MEM-01  | Long-term memory has one write path: `reflect`, through `memory-core`                 | `procedural`     | ASI06; OWASP LLM04:2025                                            | `CLAUDE.md` heading `Key Rules` (`:6-10`); `.agents/reviewer.md` heading `Checklist`, rule 4 (`:18`). No lint rule or test enforces it                                                                                                                                                                              |
| CTL-DATA-01 | No real PHI/PII, CPT code or proprietary payer content enters the repository          | `procedural`     | OWASP LLM02:2025; RMF MAP 4.1, MEASURE 2.10                        | ADR 0003 heading `Decision` (`:38`); `.agents/reviewer.md` rule 10 (`:35-48`)                                                                                                                                                                                                                                       |
| CTL-MEM-02  | Memory poisoning is red-teamed against the live write path                            | `planned`        | ASI06; OWASP LLM04:2025, LLM08:2025; 600-1 MS-2.7-007              | P4-B                                                                                                                                                                                                                                                                                                                |
| CTL-AGY-01  | Every tool declares a reversibility tier, and irreversible calls are compensable      | `planned`        | OWASP LLM06:2025; ASI02                                            | P4-C                                                                                                                                                                                                                                                                                                                |
| CTL-HUM-01  | No adverse determination is issued without a licensed clinician                       | `planned`        | RMF MAP 3.5, GOVERN 3.2; ASI09                                     | P3-A. ADR 0003 heading `Decision` states the constraint (`:53-58`)                                                                                                                                                                                                                                                  |
| CTL-AUD-01  | Each decision is recorded in a hash-chained, tamper-evident ledger                    | `planned`        | HIPAA §164.312(b), (c)(1), (c)(2); 600-1 MS-2.8-003; 42001 A.6.2.8 | P3-C                                                                                                                                                                                                                                                                                                                |
| CTL-OBS-01  | Model calls and evaluations emit OpenTelemetry GenAI semantic-convention telemetry    | `planned`        | RMF MEASURE 2.4, MANAGE 4.1; 42001 A.6.2.6                         | P2-C                                                                                                                                                                                                                                                                                                                |
| CTL-COST-01 | A run is bounded in cost, latency and steps, asserted in CI                           | `planned`        | OWASP LLM10:2025                                                   | P1-F                                                                                                                                                                                                                                                                                                                |
| CTL-ACC-01  | Access to the service is authenticated, authorized and encrypted in transit           | `not-applicable` | HIPAA §164.312(a)(1), (d), (e)(1); ASI03                           | Rationale: the Security Rule governs ePHI, and ADR 0003 decision 1 keeps ePHI out of this repository. The service is not deployed. The rationale also says what is absent: the gateway mounts JSON parsing, a correlation id and the proxy and nothing else (`server.ts:11-13`), and nothing authenticates a caller |

That is nine `implemented`, two `procedural`, seven `planned` and one `not-applicable`.
Every `planned` owner is in the index and not shipped (`docs/prd/README.md:108-143`).
None of those PRDs has a file yet, so none of them depends on P4-A. The catalogue adds no
edge to the sequencing graph, which is why `depends_on` and `blocks` are empty.

**Why not larger.** Everything else in these frameworks is either organizational or
future work with no owner. The first kind (training, roles, impact assessments, supplier
contracts) has no evidence a repository can hold, so it would be `not-applicable` in
bulk. The second would be `planned` with an invented owner. Either way a larger catalogue
would mostly contain rows that assert nothing, and they would dilute the rows that do.
Seven of eighteen planned rows is already the upper end; every one of them names a PRD
that exists in the index today.

**The exact identifiers**, pinned in the registry:

| Registry id          | Source                                                                                             | Referenced here                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `nist-ai-rmf-1.0`    | NIST AI 100-1, AI RMF 1.0, January 2023 — 72 subcategories                                         | GOVERN 1.4, 3.2, 4.3; MAP 3.5, 4.1; MEASURE 1.1, 2.3, 2.4, 2.5, 2.6, 2.7, 2.10; MANAGE 1.1, 3.1, 4.1 |
| `nist-ai-600-1`      | NIST AI 600-1, Generative AI Profile, July 2024 — suggested actions `GV-`/`MP-`/`MS-`/`MG-n.n-nnn` | MS-2.5-001, MS-2.7-001, MS-2.7-007, MS-2.8-003                                                       |
| `iso-iec-42001-2023` | ISO/IEC 42001:2023, Annex A — 38 controls                                                          | A.6.2.4, A.6.2.5, A.6.2.6, A.6.2.7, A.6.2.8                                                          |
| `owasp-llm-2025`     | OWASP Top 10 for LLM Applications 2025                                                             | LLM02:2025, LLM03:2025, LLM04:2025, LLM05:2025, LLM06:2025, LLM08:2025, LLM10:2025                   |
| `owasp-asi-2026`     | OWASP Top 10 for Agentic Applications for 2026, published 2025-12-09                               | ASI02, ASI03, ASI04, ASI06, ASI08, ASI09                                                             |
| `hipaa-164.312`      | 45 CFR §164.312 Technical safeguards, as in force — the January 2025 NPRM is not final             | (a)(1), (b), (c)(1), (c)(2), (d), (e)(1)                                                             |

The NIST texts were read from the primary PDFs, and the 72-subcategory count was taken
from AI 100-1 Tables 1–4. The OWASP identifiers were read from genai.owasp.org. The
§164.312 paragraphs were read from the CFR text. ISO/IEC 42001 is paywalled. Its Annex A
identifiers and titles here come from a secondary reproduction, and they are verified
against a licensed copy before this PRD moves to `accepted`.

## Acceptance criteria

- [ ] `governance/controls.yaml` exists, parses under the Zod schema in
      `scripts/lint-controls.mjs`, and carries the eighteen controls in the table above,
      with the statuses shown.
- [ ] `yarn lint:docs` runs `lint-controls.mjs` and exits 0 at HEAD of the P4-A pull
      request, and `ci.yml` is unchanged — the gate is the existing `yarn lint:docs` step.
- [ ] `node --test scripts/` runs one fixture per failure mode, and each exits the
      checker non-zero with a message naming the control and the cause: an `implemented`
      control with only `symbol`/`doc` anchors; a `planned` control with no `owner`; a
      `not-applicable` control with no `rationale`; a `symbol` whose file is untracked; a
      `symbol` whose name is no longer declared; a `test` title that matches nothing; a
      `test` title that is `it.skip`; a `ci` job that does not exist; a `ci` `run`
      substring that the job no longer contains; a `ref` absent from its framework's
      `clauses`; an evidence path containing `:NN`; a PRD `controls:` entry naming an
      unknown id; a `planned` control owned by a `shipped` PRD.
- [ ] Renaming `skippedTasks` in a scratch branch makes `yarn lint:docs` fail, naming
      `CTL-EVAL-02`. Inserting twenty lines above it does not. This criterion shows that
      the anchors keep resolving when lines move, which the `STATUS.md` check does not.
- [ ] `governance/CONTROLS.md` is produced by `yarn controls:matrix`, passes
      `yarn format:check`, and `yarn lint:docs` fails when it is edited by hand or when
      `controls.yaml` changes without regenerating it.
- [ ] `CONTROLS.md` shows, for each of the six frameworks, the clauses referenced and the
      number not assessed (for AI RMF 1.0, 72 minus those referenced).
- [ ] Every `planned` row names a PRD that the index lists and that is not `shipped`.
- [ ] `docs/STATUS.md` rows 3, 11 and 17 cite lines that hold what the sentence names.
- [ ] `docs/prd/_TEMPLATE.md` shows the optional `controls:` field.
      `.agents/prd-author.md` says a PRD that delivers a `planned` control lists it there.
      `.agents/reviewer.md` says a change that moves a control updates its row in the same
      pull request. `.context/workflows.md` has an "Add or change a control" entry.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Risks and open questions

- **The check proves that evidence exists, not that it is adequate.** A `test` anchor
  proves the title exists in a file that a pull-request tier runs. It does not prove that
  the test asserts what the control claims. `'carries no Google API key'` covers one key
  format (`redact.ts:14`), and CTL-SEC-01 says "no credential". A `ci` anchor proves a
  job runs a command. It does not prove that the command's threshold is right:
  `--severity high` ignores moderate advisories. The mapping from a control to a clause
  is a judgement, and some of these are arguable; CTL-LOG-01 → GOVERN 4.3 is the weakest.
  None of that is mechanical. The mitigation is the same as for `docs/STATUS.md`: every
  claim sits beside its evidence in one reviewable file, so a reader can disagree in
  thirty seconds. The matrix header says in words that a green check means "resolves",
  not "sufficient".
- **`not-applicable` is an escape hatch.** A control can be silenced by declaring it
  out of scope, as a task could be silenced by declaring an axis in P1-G. The rationale
  length rule catches an empty justification, not a wrong one. The rationale is printed in
  the matrix row and the `not-applicable` count is printed in the summary, so an exclusion
  travels with the claim.
- **A `test` anchor resolves by title and by tier, not by collection.** The checker does
  not run Vitest's `include` globs. A title inside a file the runner never collects, or
  inside a `describe.skip` above it, still resolves. Running `vitest list` inside a doc
  lint would fix that, and it would cost the lint's speed; the residual is named here
  rather than closed.
- **The ISO/IEC 42001 identifiers are from a secondary source.** If the published Annex A
  numbers them differently, five mappings are wrong. Resolved by checking a licensed copy
  before `accepted`.
- **Frameworks move.** OWASP revises its lists by year. The HIPAA Security Rule NPRM
  (90 FR 898, 2025-01-06) would make every §164.312 implementation specification required
  and add multi-factor authentication, and the rule is not final as of this draft. A new
  version is a new registry id, never an edit, so an existing mapping is not rewritten
  under a control.
- **The premise could be wrong for this audience.** Eighteen rows that touch 15 of 72
  AI RMF subcategories may read as thin to someone expecting a full statement of
  applicability. The design's answer is that the matrix states the uncovered share
  outright, and that an unfalsifiable 72-row table would be worse. If review decides the
  catalogue must enumerate every Annex A control with an explicit exclusion (38 rows,
  most `not-applicable`), that is a larger file, not a larger checker. Size stays `M`.
- **Open — changes scope.** Should P4-A move `docs/STATUS.md` from `file:line` onto the
  same resolver? It is the stronger fix for the drift in Problem, and it adds roughly a
  day. The alternative is that `STATUS.md` keeps drifting between hand corrections.
- **Open — changes scope.** Is `procedural` a status the catalogue should have? The
  alternative is to leave CTL-MEM-01 and CTL-DATA-01 out until something executable backs
  them. That is two fewer rows, and the catalogue would then be silent on the ADR 0003
  boundary.
- **Open — changes scope.** Should the ADR 0003 CPT/PHI detector get a PRD id? It would
  move CTL-DATA-01 from `procedural` to `planned` with an owner. The check needs its own
  false-positive design, which is why P4-A does not absorb it.
- **Open.** Should CTL-ACC-01 be `planned` under a new gateway-authentication PRD rather
  than `not-applicable`? The rationale is legally sound for a repository with no ePHI. A
  payer reviewer may still read it as the one row that defers the obvious work.

## References

- NIST AI 100-1, _Artificial Intelligence Risk Management Framework (AI RMF 1.0)_, January
  2023 — <https://doi.org/10.6028/NIST.AI.100-1>. Tables 1–4 hold the subcategories.
- NIST AI 600-1, _Artificial Intelligence Risk Management Framework: Generative Artificial
  Intelligence Profile_, July 2024 — <https://doi.org/10.6028/NIST.AI.600-1>.
- ISO/IEC 42001:2023, _Information technology — Artificial intelligence — Management
  system_ — <https://www.iso.org/standard/42001>. Clause 6.1.3 covers the Statement of
  Applicability; Annex A lists the controls.
- OWASP, _Top 10 for LLM Applications 2025_ — <https://genai.owasp.org/llm-top-10/>.
- OWASP, _Top 10 for Agentic Applications for 2026_, 2025-12-09 —
  <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>.
- 45 CFR §164.312, Technical safeguards —
  <https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312>.
- HHS, _HIPAA Security Rule To Strengthen the Cybersecurity of Electronic Protected Health
  Information_, NPRM, 90 FR 898, 2025-01-06 —
  <https://www.federalregister.gov/documents/2025/01/06/2024-30983>.
- NIST OSCAL — <https://pages.nist.gov/OSCAL/>. It was considered and not used; see
  Non-goals.
- `docs/STATUS.md` and `scripts/lint-docs.mjs` — the claim-to-evidence pattern this
  extends.
- `docs/adr/0003-payer-domain-with-licensing-and-phi-as-the-boundary.md` — the boundary
  CTL-DATA-01, CTL-HUM-01 and CTL-ACC-01 rest on.
