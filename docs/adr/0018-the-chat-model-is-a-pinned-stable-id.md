# 0018 · The chat model is a pinned stable id: `gemini-3.5-flash-lite`

**Status:** accepted
**Date:** 2026-11-09

## Context

The service ran on `gemini-2.5-flash` from its first live call. No record named that id or
said how one is chosen. ADR 0005 names the Gemini client and the pinned client package, not a
model. The rule that "pinned" means the stable id, because Gemini publishes no dated variant,
was written in P1-E's Problem section and in a comment at `model-deps.ts#PINNED_CHAT_MODEL`.

On 2026-11-09 Google's deprecations page gave `gemini-2.5-flash` a shutdown date of
2026-12-01: "Effective December 1, 2026, all API requests to `gemini-2.5-flash` will
automatically route to `gemini-3.5-flash-lite`." A key from a project created on 2026-10-15
already got a 404 on the old id, so the repository could not be run from a fresh clone on a
new key. After the routing date the repository would have run on another model while every
report, cassette header and live tally still named the old one. P1-I lays out each of those
consequences (`docs/prd/P1-I-chat-model-migration.md`, Problem).

P1-I planned to choose between two candidates, `gemini-3.8-flash` and
`gemini-3.5-flash-lite`, by a rule fixed before any measurement. Its rule preferred
`gemini-3.5-flash-lite` when both passed. Before the measurement finished, the owner chose.

## Decision

**The chat model is `gemini-3.5-flash-lite`, pinned by its stable id
(`apps/agent-service/src/agent/model/model-deps.ts#PINNED_CHAT_MODEL`).**

The owner's decision, 2026-11-09: "migrate it to the latest flash lite. paid for dev work,
free on ci." The owner chose the id directly. That supersedes P1-I's pre-registered rule and
its phase-1 measurement as the means of choosing. P1-I keeps what it had already started as
informational measurements, and says which ones (P1-I, "The owner's choice").

The id is the latest flash-lite, and three facts support it. Each was checked by the
conductor on 2026-11-09:

- **It is the newest stable flash-lite chat model.** The models list for the owner's key
  shows `models/gemini-3.5-flash-lite`, version `3.5-flash-lite-07-2026`, display name
  "Gemini 3.5 Flash Lite". `gemini-3.8-flash-lite-tts` is newer but is text-to-speech only.
  `gemini-flash-lite-latest` is an alias, not a pin. `gemini-3.1-flash-lite` is older.
- **It is Google's routing target for the old id.** From 2026-12-01 a request to
  `gemini-2.5-flash` is served by this model anyway. Pinning it makes that change a commit
  the repository can see, instead of a reroute behind a name it still prints.
- **Both keys can call it.** One `generateContent` on it answered 200 with `modelVersion`
  `gemini-3.5-flash-lite`, on the owner's paid key and on the repository's free key.

Its list price was $0.30 per million input tokens and $2.50 per million output tokens on
2026-11-09, the same as `gemini-2.5-flash`. So the report's cost column does not move for a
reason that has nothing to do with the agent (`apps/agent-service/src/eval/pricing.ts`).

**The service pins a stable id, never a `-latest` alias.** A cassette, a run record and a
live tally are each tied to the model that produced them. The player refuses a set recorded
on another id, and an epoch on `eval-history` is keyed on the set. An alias would move all
three under one name. The floating alias `gemini-flash-latest` is measured by the canary's
`chat-floating` probe and run by hand as a migration comparison (`EVAL_CHAT_MODEL`, the
`chat_model` dispatch). It is never the pin. The canary's `chat-pinned` probe reads
`PINNED_CHAT_MODEL`, so it always watches what the service runs.

**What starts the next migration.** Any one of these:

- a shutdown date on the pinned id less than six months away;
- a 404 on the pinned id from a key in a new project;
- a pinned `changed` on the canary.

Any of these opens a PRD, and that PRD re-records every cassette suite. A chat model id is a
re-record trigger (`.context/conventions.md`, Testing), and the player refuses a set
recorded on another id.

**Which key runs what.** The owner's paid key is for local development and recordings. CI
keeps the free repository secret. A recording made on the paid key does not draw on the
free tier's daily `generateContent` quota, so that quota no longer limits how fast a suite
can be re-recorded. The free tier still limits the nightly. `.context/conventions.md`,
"Live model quota", holds the details.

**The embedding model is out of scope.** `gemini-embedding-001` is a separate constant. It
shuts down on 2028-05-14, and new projects can still call it. Moving it re-records every
cassette and changes `EMBEDDING_DIMENSIONS`'s justification. This record does not cover it,
and the canary's metadata and embedding probes watch it.

## Alternatives rejected

- **`gemini-3.8-flash`, which the new-project 404 named.** It lists at $0.75 and $3.75 per
  million tokens, and at $1.50 and $7.50 from 2027-01-01. It is not the routing target, so
  the repository's numbers would be compared against a model nobody would run by default.
- **Finishing P1-I's seven-night measurement before choosing.** It would have ruled a model
  out and could not have shown one model better than another. The owner's choice is the
  model the rule preferred, and it is available on both keys.
- **`gemini-flash-lite-latest`.** It is an alias, and pinning an alias is what this record
  rules out.
- **Staying on `gemini-2.5-flash` until 2026-12-01.** The id closes to new projects now, and
  after that date it is served by another model under the old name.

## Consequences

**What it buys.** Every report, cassette header, run record and tally names the model that
produced it, after 2026-12-01 as before. A fresh clone on a new project's key can run a live
trial. P1-I's phase 3 checks that claim. The pinning rule, which used to live only in a PRD
and a comment, now has a record.

**What it costs.**

- **Every cassette suite is re-recorded**, and the replay baselines and the six budgeted
  tasks' budgets are regenerated from the new recording. Replay cannot tell one model from
  another (ADR 0005), so a set recorded on the old id cannot stand in for the new one.
- **The canary's baseline entries for the new id are observed with a key** and committed
  with the switch. A pinned id with no baseline entry reads as `changed`, so the scheduled
  canary on `main` would go red without them.
- **Live tallies on the two models are never pooled.** The new set's digest starts a new
  epoch, so P1-D's pooled rate starts again from the first night after the switch.
- **The owner's key carries a charge per token.** That is the owner's decision, made
  explicit here.

**Revisit when** any trigger above fires, or when the provider publishes dated variants that
can be pinned more narrowly than the stable id.
