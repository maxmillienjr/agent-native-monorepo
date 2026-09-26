<!-- Generated from governance/controls.yaml by `yarn controls:matrix`. Do not edit by hand: `yarn lint:docs` fails when this file differs from what the catalogue renders. -->

# Controls

4 controls: 1 `implemented`, 1 `procedural`, 1 `planned`, 1 `not-applicable`.

**A green check means the evidence resolves, not that it is sufficient.** `yarn lint:docs` proves that each anchor below exists at HEAD: the symbol is declared, the test title is present and not skipped in a tier a pull-request workflow runs, the workflow job exists and runs the named command, the heading is there. It does not prove that a test asserts what its control claims, that a threshold is right, or that a mapping to a clause is the best one. Those are judgements, and each sits beside its evidence so a reader can disagree with it.

**Coverage is not claimed.** The check asserts that every catalogued control has evidence, not that every clause of a framework has a control. Each framework section below says how many of its clauses no control here addresses.

| Status           | Means                                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| `implemented`    | A test or a CI job fails if the control stops holding.                  |
| `procedural`     | A person enforces it by applying a written rule. No check does.         |
| `planned`        | Not delivered. The owner is the PRD that delivers it.                   |
| `not-applicable` | Excluded, with the justification a Statement of Applicability requires. |

## Catalogue

| Id          | Control                            | Status           | Maps to  | Evidence, owner or rationale                                                                                                                                                                                           |
| ----------- | ---------------------------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTL-TEST-01 | The guard holds                    | `implemented`    | Demo D-1 | [`guard`](../packages/demo/src/guard.ts); test [`'holds the line'`](../packages/demo/src/guard.test.ts) (unit); [`fixture.yml`](../.github/workflows/fixture.yml) job `check`, runs `yarn npm audit` — on pull_request |
| CTL-RULE-01 | A reviewer applies the rule        | `procedural`     | Demo D-2 | [`docs/rule.md`](../docs/rule.md) § The rule                                                                                                                                                                           |
| CTL-PLAN-01 | Something P8-B delivers            | `planned`        | Demo D-1 | Owner: P8-B                                                                                                                                                                                                            |
| CTL-NA-01   | Something this fixture does not do | `not-applicable` | Demo D-2 | Rationale: The fixture has no network surface, so there is nothing for this to guard.                                                                                                                                  |

## Frameworks

### Demo framework

Registry id `demo-fw`, edition of 2026-01. Source: <https://example.com/demo>.

**2 of 5 clauses referenced; 3 not assessed.** Fixture text.

| Clause | Text               | Controls                 |
| ------ | ------------------ | ------------------------ |
| D-1    | The first clause.  | CTL-TEST-01, CTL-PLAN-01 |
| D-2    | The second clause. | CTL-RULE-01, CTL-NA-01   |
