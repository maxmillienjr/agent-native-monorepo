---
id: P3-C
title: Hash-chained, tamper-evident decision ledger
tier: 3
status: in-progress
size: L
depends_on: [P3-A, P3-B]
blocks: []
issue: 108
superseded_by: null
controls: [CTL-AUD-01]
---

# P3-C · Hash-chained, tamper-evident decision ledger

## Problem

Nothing the repository persists can show that it has not been changed.

- **The audit log is a log line.** `AuditInterceptor` writes `run.complete` with the run id,
  duration, token counts and outcome to the service logger
  (`common/interceptors/audit.interceptor.ts:20-30`). It records nothing the run decided
  and nothing an auditor could check against.
- **Every stored row is rewritable by the role that wrote it, by design.** The checkpointer
  upserts checkpoints `ON CONFLICT … DO UPDATE` and deletes whole threads
  (`@langchain/langgraph-checkpoint-postgres@0.1.3`, `dist/sql.js:55-60`, `:73-75`); the
  pgvector writer upserts (`pgvector.writer.ts:34`); Neo4j concepts are overwritten
  `ON MATCH` (`neo4j.writer.ts:47-49`). P3-B adds a run record beside the checkpoints and
  says outright that its replay proves a record complete and consistent, not unaltered: a
  consistent edit to the decisions and the checkpoints passes it.
- **P3-A hands two things here and nothing yet receives them.** Its types guarantee that an
  adverse determination carries an attestation; they "cannot guarantee the record describes
  a real review by a real reviewer. Binding an attestation to an authenticated identity and
  making it tamper-evident is **P3-C**" (`docs/prd/P3-A-clinician-gate.md:129-132`). Its
  review decided that this ledger "records determinations and attestations, with the
  agent's recommendation that preceded each" (`:393-395`).
- **P2-C hands two more.** Opt-in content capture, whose recommended pattern is a separate
  access-controlled store referenced from the span, which P2-C named "the decision ledger"
  (`docs/prd/P2-C-otel-genai-semantics.md:139-143`); and "a hash of a short fact is
  enumerable … for real member data a keyed hash would be needed, and that is P3-C's
  question" (`:622-624`).
- **P4-A catalogues the control and names this PRD its owner**: `CTL-AUD-01`, "Each
  decision is recorded in a hash-chained, tamper-evident ledger", `planned`, mapped to
  HIPAA § 164.312(b), (c)(1) and (c)(2) (`docs/prd/P4-A-controls-as-code.md:305`).

Three facts about Postgres decide what a ledger in it can promise. Each was checked on
2026-09-26 against `pgvector/pgvector:pg16` with a probe table (deleted afterwards): a role
granted only `SELECT, INSERT` got `permission denied` on `UPDATE`, `DELETE` and `TRUNCATE`;
a `BEFORE UPDATE OR DELETE` trigger raising an exception stopped the table's owner; and the
superuser, after `SET session_replication_role = replica`, updated the row anyway. A `UNIQUE`
constraint on `prev_hash` rejected a second entry claiming the same predecessor. So the
database can stop the service from rewriting history, and cannot stop a database
administrator. Only something outside the database can.

## Why it matters

HIPAA's Security Rule asks for "mechanisms that record and examine activity" (45 CFR
§ 164.312(b)) and, as an addressable specification, "electronic mechanisms to corroborate
that electronic protected health information has not been altered or destroyed in an
unauthorized manner" (§ 164.312(c)(2)). A payer that issues a denial on the recommendation
of a software tool will be asked, in an appeal or an audit, what the tool recommended, which
licensed reviewer decided, and whether either record changed afterwards. Crosby and Wallach
state the property precisely: the logger "must be able to prove that individual logged
events are still present, and that the log, as seen now, is consistent with how it was
seen in the past", and "an untrusted logger is free to have different snapshots make
inconsistent claims about the past" unless auditors hold its commitments (2009, abstract,
§1, §2.2).
Certificate Transparency is the deployed example of the same idea (RFC 9162, which
obsoletes RFC 6962).

**What does not apply.** 21 CFR Part 11 governs electronic records kept "under any records
requirements set forth in agency regulations" of the FDA (§ 11.1(b)); a health plan's
coverage determination is not one. Its audit-trail wording — "Record changes shall not
obscure previously recorded information" (§ 11.10(e)) — is a fair description of an
append-only ledger, and this PRD claims no Part 11 compliance.

## Scope

- **`packages/decision-ledger`** (`@repo/decision-ledger`): the entry schema, the
  commitment and chain hashes, an append that serialises writers, a pure `verifyChain`
  over rows, its own migrations, and a `roles.sql` that creates an insert-only role.
- **Five entry kinds**: `run.recorded` (a digest of P3-B's run record and checkpoint
  history), `disposition.recommended` (an `AgentDisposition` a run produced),
  `determination.attested` (a clinician's signed determination citing the recommendation
  it followed), and `reviewer-key.registered` / `reviewer-key.revoked`.
- **Salted commitments** rather than bare hashes, so the chain can leave the database
  without the content being guessable from it.
- **Ed25519 signatures on attestations**, verified on append and again by the verifier
  against keys that are themselves ledger entries.
- **RFC 3161 anchoring**: `ledger:anchor` timestamps the head hash with an external
  Time-Stamping Authority and stores the token.
- **`ledger:verify`**: walks the chain, checks commitments, signatures and anchors, and
  re-derives each `run.recorded` digest from the current run record and checkpoints.
- **The wiring**: `RunsService` appends `run.recorded` after every run on the configured
  ledger axis, and `disposition.recommended` when a run's state carries one.
- **The boundary**: an ESLint rule forbidding `@repo/decision-ledger` under
  `apps/agent-service/src/agent/**`; `.agents/reviewer.md` rule 4 and the first key rule in
  `CLAUDE.md` amended to name the packages that own database writes.
- The answers to P2-C's two questions, written into the "Before real data" section P3-B
  creates, and `docs/STATUS.md` rows.

### Non-goals

- **A reviewer surface, and who holds the private keys.** The ledger verifies a signature;
  producing one needs a clinician-facing route. **P3-E** owns it, and its
  `determination.attested` appends are the ledger's first producer of that kind. _Amended
  2026-10-08:_ this said P3-D, which handed the review surface to P3-E at its review. P3-E
  has shipped the route, its reviewers' clients sign, and its `decide` has a `beforeCommit`
  hook where this PRD's append goes.
- **Identity proofing and key custody.** A signature binds an attestation to a key, not to a
  person. That the key's holder is the licensed reviewer named in the registration is
  § 164.312(d) person-or-entity authentication, a deployment control with an identity
  provider and an HSM behind it. This repository cannot evidence it; it goes on the
  "Before real data" list.
- **Tamper-evident memory.** `episodes`, `semantic_facts` and the graph are mutable by
  design (idempotent upserts, ADR 0001) and are not audit records — P3-B showed a second run
  leaves no trace in them. The ledger commits to the run record, which says what each run
  wrote.
- **Merkle trees and membership proofs.** Rejected for now, not deferred: see the design.
- **Publishing anchors on a schedule.** The command exists; running it periodically and
  archiving the tokens outside the database is an operator's job in a deployment this
  repository does not have.
- **Deletion.** Nothing here deletes an entry. Withholding a payload is described below; a
  retention job belongs with P3-B's open retention question.

## Design

### Why the ledger is not memory, and not in `memory-core`

`CLAUDE.md` says "All memory writes go through packages/memory-core", and reviewer rule 4
forbids database calls outside it (`.agents/reviewer.md:18-19`). The ledger lives in its own
package anyway, for one reason that the other two follow from: **it needs a different
database role**. Memory's writes are upserts and need `UPDATE`
(`.context/workflows.md:129-131`); the checkpointer needs `UPDATE` and `DELETE` on its own
tables; the ledger's value is that its writer has neither. One pool cannot be both, and a
package boundary that follows the role boundary is the one a reviewer can check. The agent
never reads the ledger, so it is not a memory tier either. P3-B's run record, by the same
test, does belong in `memory-core`: it is written by the service's role like the
checkpoints beside it.

That leaves rule 4 naming one owner when the repository has three. The saver already writes
its own tables from `memory/memory.module.ts:116-117`, an exception no document states. The
amendment names all three: `memory-core` for memory, the checkpointer for its own tables,
`decision-ledger` for the ledger.

The package depends on `pg`, `zod` and `node:crypto`, and on nothing in the repository
except `@repo/determination` for P3-A's `DeterminationRecordSchema` — the reader schema,
which validates a stored determination without being able to mint one
(`docs/prd/P3-A-clinician-gate.md:262-267`). An auditor can run `verifyChain` over an export
without the service.

### Tables

```sql
CREATE TABLE ledger_entries (
  seq         bigint PRIMARY KEY CHECK (seq >= 0),
  entry_id    uuid   NOT NULL UNIQUE,          -- caller-supplied; makes a retried append idempotent
  kind        text   NOT NULL,
  recorded_at timestamptz NOT NULL,
  prev_hash   bytea  NOT NULL UNIQUE,          -- 32 zero bytes for seq 0; UNIQUE forbids a fork
  commitment  bytea  NOT NULL,
  entry_hash  bytea  NOT NULL UNIQUE
);
CREATE TABLE ledger_payloads (
  entry_id uuid PRIMARY KEY REFERENCES ledger_entries (entry_id),
  salt     bytea NOT NULL CHECK (octet_length(salt) = 16),
  payload  text  NOT NULL                      -- the exact canonical JSON that was hashed
);
CREATE TABLE ledger_anchors (
  seq bigint PRIMARY KEY REFERENCES ledger_entries (seq),
  tsa_url text NOT NULL, token bytea NOT NULL, anchored_at timestamptz NOT NULL
);
```

A trigger rejects `UPDATE` and `DELETE` on `ledger_entries` and `ledger_anchors`, and
`UPDATE` on `ledger_payloads`. Deleting a payload is left to the owner so that content can
be withheld under a retention or minimum-necessary policy while the entry that committed to
it stays; the verifier reports such an entry as withheld, not as tampered. The payload is
stored as text because the verifier must hash the bytes that were hashed — `jsonb`
normalises on the way in. Migrations run through Drizzle's migrator with
`migrationsTable: '__ledger_migrations'`, which `drizzle-orm@0.45.2` supports
(`migrator.d.ts:7-8`), so the ledger's schema history is separate from memory's.

`roles.sql` creates `ledger_writer` with `SELECT, INSERT` on the three tables. The service
reads `LEDGER_DATABASE_URL`, a third axis beside memory and model, with the repository's
existing rule: unset means no ledger and `docs/STATUS.md` says so; set and unreachable
exits 1 at boot. There is no fallback to `DATABASE_URL`, because a ledger written with the
memory role is a ledger its writer can rewrite.

### Hashes

```
commitment = SHA-256( salt ‖ payload )                  -- salt: 16 random bytes
entry_hash = SHA-256( canonicalJson({ v: 1, seq, entryId, kind, recordedAt,
                                      prevHash: hex, commitment: hex }) )
```

`canonicalJson` is `@repo/agent-cassette`'s, copied rather than imported so the package
stays liftable; a test asserts the two produce identical bytes on a shared corpus.

**Salted, not keyed.** P2-C's worry is that a hash of short content can be reversed by
enumerating candidates. A per-entry random salt defeats that: "It also makes it infeasible to
guess the preimage of the digest … by enumerating the potential value space" (RFC 9901
§9.3, which recommends at least 128 bits). An HMAC under a deployment key would too, but
losing the key would make every commitment unverifiable and leaking it would make every
one enumerable at once; a salt lives beside its own payload and dies with it. The chain
rows, the head hash and the anchors can therefore be exported to an auditor, or to a TSA,
without disclosing anything.

**The span attribute is a different case.** `fact.contentHash` on spans is the idempotency
key of `semantic_facts` and must be equal across runs to correlate traces, so it cannot be
salted per use. Under ADR 0003 the facts are synthetic and it stays. For real member data
it becomes an HMAC-SHA256 under a deployment secret, or is removed from spans; that goes on
the "Before real data" list, owned by the deploying entity, beside P3-B's items.

**Content capture.** P2-C's opt-in switch is closed without code: the separate,
access-controlled content store the conventions describe is P3-B's run record, every node
span already carries `run_id` as the reference to it, and the ledger holds a commitment to
the record rather than the content. No span gains content.

### Entries

```ts
type LedgerPayload =
  | {
      kind: 'run.recorded';
      runId: string;
      gitSha: string | null;
      outcome: string | null;
      decisionCount: number;
      checkpointCount: number;
      runDigest: string;
    }
  | {
      kind: 'disposition.recommended';
      runId: string;
      runEntrySeq: number;
      disposition: AgentDisposition;
    }
  | {
      kind: 'determination.attested';
      runId: string | null;
      recommendationSeq: number | null;
      determination: DeterminationRecord;
      reviewerKeyId: string;
      signature: string;
    }
  | {
      kind: 'reviewer-key.registered';
      reviewerKeyId: string;
      reviewerId: string;
      credential: { type: string; jurisdiction: string };
      publicKey: string;
    }
  | { kind: 'reviewer-key.revoked'; reviewerKeyId: string; reason: string };
```

`runDigest` is SHA-256 over the canonical JSON of the `run_records` row, its ordered
`run_decisions`, and the `{ next, values }` of every checkpoint in `getStateHistory`, read
back from Postgres after the run finishes so that it commits to what was stored. It is
computed by a function in `memory-core`'s audit module (P3-B's) plus the saver, in
`apps/agent-service`, because the ledger package must not learn what a checkpoint is.

`determination.attested` is refused on append unless the signature verifies over
`canonicalJson({ determination, recommendationSeq, runId })` with a key registered earlier
in the chain and not revoked, and unless `recommendationSeq` names the run's
`disposition.recommended` entry whenever the run has one. That is P3-A's decision made
mechanical: the ledger cannot hold a determination detached from the recommendation it
followed. Because keys are entries, the registry is tamper-evident on the same terms as
everything else.

`RunsService` appends after the invoke settles, success or failure, outside the graph. The
ESLint rule keeps it there: the agent cannot write the ledger, as it cannot mint a denial
(P3-A). A failed append does not fail the response; it is logged, and the verifier lists
every `run_records` row with no `run.recorded` entry, so the gap is visible rather than
silent. `determination.attested` is the opposite: P3-E's review route must not issue a
determination whose append failed.

### Appending

One transaction: `pg_advisory_xact_lock` on a constant key, read the head, insert
`seq + 1` with `prev_hash` = head's `entry_hash`, insert the payload, commit. The `UNIQUE`
constraints on `seq` and `prev_hash` hold the chain linear even if the lock is bypassed. A
retry with an `entry_id` already present returns the stored entry if its payload's canonical
bytes match and throws otherwise.

### Anchoring

`ledger:anchor` builds an RFC 3161 request over the head `entry_hash` with
`openssl ts -query -digest <hex> -sha256 -cert`, posts it to `LEDGER_TSA_URL`, and stores
the token. The TSA sees only the hash — RFC 3161 §2.1 requires it "not to examine the
imprint being time-stamped in any way". Checked 2026-09-26 against FreeTSA with OpenSSL
3.0.13: the request returned a 4,644-byte granted token, `openssl ts -verify` against
FreeTSA's published CA answered `Verification: OK`, and the same token against different
data failed with `message imprint mismatch`. No SDK and no ASN.1 dependency: OpenSSL does
the encoding and the CMS verification. Tests run a local TSA with `openssl ts -reply` under
a CA generated in the test, so CI needs no network.

### Verifying

`ledger:verify` exits 0 when all of these hold, 1 naming the first failure, 2 when it cannot
check (a missing CA, an unreachable database):

1. `seq` is contiguous from 0, and each `prev_hash` is the previous `entry_hash`.
2. Each `entry_hash` recomputes from its row.
3. Each present payload recomputes to its `commitment`; absent ones are counted as withheld.
4. Each attestation's signature verifies under a key registered before it and not revoked.
5. Each anchor's token verifies against the configured CA and imprints the `entry_hash` at
   its `seq`.
6. Each `run.recorded` digest recomputes from the current run record and checkpoints.
7. Every `run_records` row has a `run.recorded` entry, or is listed as uncommitted.

`--chain-only` runs 1-5 from the package alone, over a database or a JSONL export.

### The threat model, stated plainly

| Actor                                       | Prevented by                                                                | Detected by                                               | Not addressed                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Graph code writing a determination/entry    | P3-A's types and lint; this PRD's import rule                               | —                                                         | —                                                                     |
| Service credentials (bug, injection, theft) | `ledger_writer` has no `UPDATE`/`DELETE`/`TRUNCATE` (probed)                | Forged attestations fail the signature check              | Appending false `run.recorded` entries                                |
| Edits to run records or checkpoints         | —                                                                           | `runDigest` mismatch                                      | Edits in the milliseconds before the digest is appended               |
| Database administrator                      | Nothing: `session_replication_role = replica` bypasses the trigger (probed) | Any rewrite of an entry at or before the last anchor      | A consistent rewrite, or truncation, of entries after the last anchor |
| Deleted anchor tokens                       | —                                                                           | Only if the operator archived tokens outside the database | Otherwise, the DBA case above                                         |
| A stolen reviewer key                       | —                                                                           | —                                                         | Key custody and revocation timing; a deployment control               |

The DBA row is the honest limit of any ledger held by the party it audits. Crosby and
Wallach's remedy is that commitments leave the logger and reach auditors (§2.2); here the
TSA token is that commitment, and the window of undetectable rewrite is the interval
between anchors. A test asserts both halves: a superuser rewrite of every hash from an
anchored entry onward fails verification, and the same rewrite confined to entries after
the last anchor passes it.

### Why a chain and not a tree

A hash chain's proof that one entry is present includes every entry after it; Crosby and
Wallach call chains "only feasible with low event volumes or in situations where every
auditor is already receiving every event" (§3.1), and propose a history tree with
logarithmic proofs. This ledger's volume is one entry per run, and its one auditor reads the
whole log, so the chain is sufficient and much simpler to verify by hand. The revisit
trigger is a party who must check one determination — a member's appeal — without being
shown the rest of the log. That needs an RFC 9162-style Merkle tree with inclusion proofs,
and would be a new PRD.

### Relationship to P4-A

`CTL-AUD-01` is `planned` under this PRD. P4-A is accepted, not shipped, so
`governance/controls.yaml` does not exist at `77e3191`. Whichever of the two lands second
moves the control, as `implemented` for runs — the one kind with a live producer — with
determinations noted as P3-E's.

## Acceptance criteria

- [ ] `yarn workspaces list` includes `@repo/decision-ledger`; its runtime dependencies are
      `pg`, `zod` and `@repo/determination`, and nothing else in the repository.
- [ ] Integration tests on live Postgres: as `ledger_writer`, `UPDATE`, `DELETE` and
      `TRUNCATE` on `ledger_entries` fail with `permission denied`; as the owner, `UPDATE`
      fails with the trigger's exception; an insert reusing a `prev_hash` fails on the
      unique constraint.
- [ ] Fifty concurrent appends from five pools produce `seq` 0-49 with no gap, and
      `verifyChain` passes.
- [ ] A retried append with the same `entry_id` and payload returns the original entry; with
      a different payload it throws.
- [ ] `ledger:verify` exits 1, naming the `seq`, for each of: an edited payload, an edited
      row, a deleted middle entry, two swapped entries, an attestation signed by an
      unregistered key, and one signed by a revoked key. A deleted payload is reported as
      withheld and exits 0.
- [ ] A superuser rewrite of every hash from an anchored entry onward exits 1 on the
      anchor; the same rewrite of entries only after the last anchor exits 0, and the test
      says that this is the documented limit.
- [ ] `ledger:anchor` against the local test TSA stores a token that `ledger:verify` checks,
      in CI with no network. One anchor against a public TSA is recorded in the pull
      request.
- [ ] One `POST /runs` with the ledger configured leaves one `run.recorded` entry whose
      digest `ledger:verify` re-derives; editing one of that run's checkpoint blobs, or one
      of its `run_decisions`, makes it exit 1 naming the run. Model `stub` / memory `live`,
      and again on model `replay` / memory `live`.
- [ ] A run with the ledger configured and its database stopped mid-run still answers
      `POST /runs`, and `ledger:verify` lists it as uncommitted.
- [ ] Unit tests: `appendAttestation` refuses an unsigned determination, a signature by a
      key not in the chain, and a determination on a run with a recommendation that does
      not cite it. Every fixture reviewer and key is labelled synthetic.
- [ ] A Vitest test lints an import of `@repo/decision-ledger` under `src/agent/` and gets one
      `no-restricted-imports` error, and under `src/runs/` gets none.
- [ ] `.agents/reviewer.md` rule 4 and `CLAUDE.md` name the three owners of database writes;
      `.context/conventions.md`'s "Before real data" includes the keyed span digest and key
      custody.
- [ ] `docs/STATUS.md` has two rows: run records committed to the ledger, `implemented`;
      determinations and attestations in the ledger, appended from P3-E's review route, with
      the evidence of that append. _Amended 2026-10-08:_ this row was `stubbed` with owner
      P3-D; P3-E shipped the producer first, so this PRD wires the append into it.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Risks and open questions

- **Sized `L`, not the index's `M`.** A package with its own migrations and role, a
  concurrent append, commitments, signatures, an OpenSSL-driven anchor with an offline test
  TSA, the verifier, and service wiring that depends on P3-B's record existing. The test
  TSA is the part most likely to cost more than it looks: `openssl ts -reply` needs a
  signing certificate with a critical `timeStamping` extended key usage and a config file.
- **The premise could be wrong if the auditor is the database administrator's employer.**
  Everything above assumes the anchors reach someone the DBA does not control. In a
  single-operator deployment with no one verifying against archived tokens, the ledger
  detects nothing a DBA does. The PRD states this; it cannot fix it.
- **Until P3-D, the determination half has no producer.** `disposition.recommended` fires
  only when the P3-A channel is set, and nothing sets it; attestations have no caller. The
  `stubbed` row is the honest status. If P3-D chooses a different reviewer flow — the
  reviewer's client signs, or the server signs on the reviewer's authenticated session —
  the signature field survives either way; who holds the key changes.
- **Open question — should a failed `run.recorded` append fail the run?** This draft says no
  and makes the gap visible. A reviewer who reads § 164.312(b) as requiring the record may
  want the opposite, at the cost of availability. **Decided at review, 2026-09-26:** the
  same split as P3-B — fail closed on the path that produces a recommendation or a
  determination, a visible gap on the chat path.
- **Open question — one TSA or two.** A single TSA is a single party whose key compromise
  or collusion defeats the anchor. Anchoring to two independent TSAs doubles the calls and
  removes that; this draft uses one. **Decided at review, 2026-09-26: one**, with two named
  in "Before real data" as the production posture.
- **P2-C's text still names the ledger as the content store.** This PRD resolves it the
  other way — the run record is the store, the ledger commits to it — and the correction
  lives here, not in P2-C.
- **The regulatory reading is a portfolio's, not counsel's.** § 164.312(c)(2) is
  addressable, not required; nothing here claims compliance with it or with Part 11.

## References

- S. A. Crosby and D. S. Wallach, "Efficient Data Structures for Tamper-Evident Logging",
  USENIX Security 2009, pp. 317-334,
  https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf — §1, §2.2, §2.4
  (forward integrity), §3.1.
- B. Schneier and J. Kelsey, "Secure Audit Logs to Support Computer Forensics", ACM TISSEC
  1(3), 1999 — the hash-chained log Crosby and Wallach improve on.
- RFC 3161, Time-Stamp Protocol (updated by RFC 5816), https://www.rfc-editor.org/rfc/rfc3161
- RFC 9162, Certificate Transparency Version 2.0 (obsoletes RFC 6962),
  https://www.rfc-editor.org/rfc/rfc9162
- RFC 9901, Selective Disclosure for JSON Web Tokens, §9.3,
  https://www.rfc-editor.org/rfc/rfc9901
- 45 CFR § 164.312(b), (c)(1), (c)(2), (d), https://www.law.cornell.edu/cfr/text/45/164.312
- 21 CFR § 11.1(b) and § 11.10(e), https://www.law.cornell.edu/cfr/text/21/part-11
- `docs/prd/P3-A-clinician-gate.md`, `docs/prd/P3-B-audit-replay.md`,
  `docs/prd/P2-C-otel-genai-semantics.md`, `docs/prd/P4-A-controls-as-code.md`.
