---
id: P5-A
title: Agent2Agent v1.0 server with a signed Agent Card
tier: 5
status: accepted
size: L
depends_on: []
blocks: [P5-B]
issue: null
superseded_by: null
controls: [CTL-ACC-01]
---

# P5-A · Agent2Agent v1.0 server with a signed Agent Card

## Problem

Another agent has no way to find this one or call it, and nothing checks who is calling.

**Nothing authenticates a caller.** Run on 2026-09-26 at `f0d55bd`: `node dist/main.js` in
`apps/agent-service`, no `.env`, `DATABASE_URL`, `NEO4J_URI` and `GOOGLE_API_KEY` unset.
`POST /runs` with no credential answered `200`, and a request carrying
`Origin: https://evil.example` came back with `Access-Control-Allow-Origin: *`, which is
`app.enableCors()` with no options (`apps/agent-service/src/main.ts:26`). A search of
`apps/agent-service/src`, `apps/gateway/src` and `apps/console/src` for `guard`, `authoriz`,
`authentic`, `passport`, `bearer` and `x-api-key` finds two comments and no code. The
gateway mounts JSON parsing, a correlation id and the proxy and nothing else
(`apps/gateway/src/server.ts:11-13`), and it is not the only door: the compose file
publishes the service itself on the host (`docker-compose.yml:39-40`). P4-A records this as
CTL-ACC-01 (`docs/prd/P4-A-controls-as-code.md:308`) and decided at review that the control
is `planned` under this PRD (`P4-A-controls-as-code.md:428-432`).

**There is no discovery or agent-to-agent surface.** In the same run,
`GET /.well-known/agent-card.json` answered `404`. The HTTP surface is `POST /runs` and
`POST /runs/stream` (`runs/runs.controller.ts:6,15,24`) and `GET /health` (`main.ts:29`).

**The existing stream cannot carry a result.** The same run's `POST /runs/stream` emitted
eight frames — `{"node":"ingress"}` through `{"node":"egress"}`, then `{"node":"done"}` —
and no answer text. `stream()` writes the node name of each update and nothing else
(`runs.service.ts:360-367`). `StreamEventSchema` has `delta` and `state` fields
(`packages/agent-contracts/src/run-response.schema.ts:20-45`) that no code sets. The only
path that folds the updates into a final state is `executeTraced`
(`runs.service.ts:321-330`), which the evaluation harness calls and HTTP does not.

**The contract assumes the client holds the conversation; A2A assumes the server does.**
`RunRequestSchema` requires a `sessionId` UUID and the whole message history
(`run-request.schema.ts:11-15`), and `reflect` writes every message at its array index as
`turnIndex` (`agent/nodes/reflect.node.ts:40-49`). An A2A client sends one message per call
and a `contextId` (A2A §3.4.1). An adapter has to rebuild the history, and the one read
that can is `EpisodicRepository.findBySession`, which returns rows newest-first by
`createdAt` with a default limit of 50 (`packages/memory-core/src/episodic/episodic.repo.ts:6-9`,
`:79-99`). Passing the newest 50 turns re-indexed from zero would collide with stored
`(session_id, turn_index)` keys, and `ON CONFLICT DO NOTHING` (`episodic.repo.ts:57`) would
drop the new user turn without an error.

**A Nest controller cannot receive A2A bodies as the app is configured.**
`app.useGlobalPipes(new ZodValidationPipe(RunRequestSchema))` (`main.ts:25`) validates every
controller `@Body()` against the run request, so a JSON-RPC envelope would be answered
`400`. The correlation id is minted by `LoggingInterceptor`
(`common/interceptors/logging.interceptor.ts:16-34`), and interceptors run only for Nest
controllers.

**Trace context stops at the process boundary.** P2-C hands cross-service propagation to
this PRD: "The first PRD with a second agent calling this one over HTTP is **P5-A**, and it
inherits W3C context propagation" (`docs/prd/P2-C-otel-genai-semantics.md:147-151`).

### What the protocol and the SDK are, measured

**The specification.** A2A v1.0.0 was released on 2026-03-12 and v1.0.1 on 2026-05-28, from
`github.com/a2aproject/A2A` under the Linux Foundation. The proto file is the normative
definition (§1.4). The v1.0 JSON-RPC methods are PascalCase — `SendMessage`,
`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask` (§5.3, §9.1). The
`message/send` names are v0.3. The card lives at `/.well-known/agent-card.json` (§8.2). A
request with no `A2A-Version` header MUST be treated as version 0.3 (§3.6.2). Signing
(§8.4) is a JWS (RFC 7515) over the card canonicalized with JCS (RFC 8785), with protected
header `alg`, `typ` and `kid`, and optionally `jku`. The `signatures` field is excluded, and
fields holding default values are removed first.

**The SDK.** `@a2a-js/sdk@1.2.1` was published on 2026-09-24; 1.0.0 was 2026-07-22. Its
Express peer range is `^4.21.2 || ^5.1.0`, and it depends on `jose ^6.2.3`. It ships
`generateAgentCardSignature`, `verifyAgentCardSignature` and `canonicalizeAgentCard`, an
`InMemoryTaskStore` that scopes tasks by owner, a JSON-RPC Express handler, and an opt-in
v0.3 compatibility layer (`legacyCompat`).

**A spike, out of tree.** Run on 2026-09-26 in a scratch directory with `@a2a-js/sdk@1.2.1`,
`express@5.2.1`, `@nestjs/core@11.2.6`, `jose@6.2.12` and `canonicalize@2.1.0`. Nothing from
it is committed.

| Question                                                | Result                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do the SDK's Express handlers work inside Nest 11?      | Yes. Mounted with `app.use` on a `NestFactory.create` app, the card answered `200` and `SendMessage` completed a task. A global pipe that throws on every call did not fire for them.                                                                                                                                                                                   |
| What does a request with no `A2A-Version` get?          | JSON-RPC error `-32009`, "The requested A2A protocol version '0.3' is not supported". The handler is strict v1.0 unless `legacyCompat` is on.                                                                                                                                                                                                                           |
| Does the SDK's signature cover the whole card?          | **No, not for every card.** With `securityRequirements: [{ schemes: { apiKey: { list: [] } } }]` the SDK's canonical form omits `securityRequirements` entirely, so the signature does not cover it. An independent RFC 8785 form includes it, and the SDK's signature fails to verify over it.                                                                         |
| Does it follow the spec's own canonicalization example? | No. For the §8.4.1 example the SDK drops `"description": ""` and `"skills": []`, both of which the spec says to keep because they are `REQUIRED`. Its `cleanEmpty` strips every empty string, array and object.                                                                                                                                                         |
| Is there a card shape where the two agree?              | Yes. With a non-empty requirement list, `{ bearer: { list: ["agent.invoke"] } }`, the SDK form and the independent form are byte-identical. The signature verifies over both, and a changed interface URL fails.                                                                                                                                                        |
| What does the conformance kit say?                      | `a2a-tck` at `263b9cf` (2026-09-01), `--transport jsonrpc --level must`, against an executor that always returns one text artifact: 68 passed, 5 failed, 162 skipped, 30 deselected in 0.79 s. All five failures are scripted scenarios. The TCK selects SUT behaviour by `messageId` prefix (`scenarios/core_operations.feature`) and asserts on the scripted content. |

Three more facts bear on the design. The TCK's JSON-RPC client sets only the `A2A-Version`
header (`tck/transport/jsonrpc_client.py`, `httpx.Client(headers=...)`) and cannot send a
credential. Its card-signing tests, CARD-SIGN-001 to 004, are an open backlog item
(`backlog/tasks/task-29`, status "To Do"). And the TCK has no 1.0 release: its newest tag
is `1.0.0.alpha2` from 2026-05-27. The a2a-js repository runs only the v0.3 TCK suite in
its own CI (`.github/workflows/run-tck-compat.yaml` pins `0.3.0.beta5`). **I found no
certification program for A2A.** What a server can claim is "passes the TCK's MUST-level
JSON-RPC tests at commit X", with the exceptions named.

Last, **ADK for TypeScript 2.1.0 depends on `@a2a-js/sdk ^0.3.10`** (`core/package.json:85`
in `google/adk-js`), a v0.3 client. A strict v1.0 server rejects it with `-32009`.

## Why it matters

A2A is the protocol one agent uses to call another without either knowing the other's
framework. It was published by Google in 2025 and is now governed under the Linux Foundation.
Google's agent platform, formerly Vertex AI and now the Gemini Enterprise Agent Platform,
lists it as a supported integration. A signed Agent Card is how a caller checks that the
endpoint and security requirements it read were published by the key holder and not by
someone between them. For this repository the protocol matters more than the transport. It
is the honest answer to "would this work with our ADK agents?": an ADK agent can call this
one over A2A without a port, which is the recommendation P5-B's appendix will make. The
authentication half matters on its own. CTL-ACC-01 maps to HIPAA §164.312(d), person or
entity authentication, and to OWASP ASI03, identity and privilege abuse. It is the one row
in P4-A's catalogue that defers the obvious work.

## Scope

- An A2A v1.0 JSON-RPC server inside `apps/agent-service`, serving `SendMessage`,
  `SendStreamingMessage`, `GetTask`, `ListTasks` and `CancelTask`, built on
  `@a2a-js/sdk ^1.2.1`.
- An Agent Card at `/.well-known/agent-card.json`, signed with ES256 when a key is
  configured, with public keys at `/.well-known/jwks.json` and a rotation procedure.
- A mapping from A2A tasks and contexts to runs and sessions that keeps `reflect` as the
  only memory writer.
- Bearer-credential authentication on the service's whole external surface — `/runs`,
  `/runs/stream`, `/a2a/*` — enforced at the service, with the gateway and the console
  forwarding a credential.
- Task and conversation ownership scoped to the authenticated principal on the A2A surface.
- v0.3 compatibility on the same endpoint, so an ADK 2.1.0 agent can call it.
- W3C trace-context extraction on the external routes, and injection by the gateway.
- Conformance: service-tier specs, and the TCK in `e2e.yml` against the compose stack.
- An ADR for the authentication decision; new `docs/STATUS.md` rows; the README
  quickstart; the P4-A catalogue rows below.

### Non-goals

- **gRPC and HTTP+JSON bindings.** One binding satisfies the spec. §5.1 requires every
  declared binding to be functionally equivalent, so each extra one triples the conformance
  surface for no caller that needs it. **No PRD owns this.**
- **Push notifications.** Runs take seconds; `capabilities.pushNotifications` is `false`.
  **No PRD owns this.**
- **Tasks that outlive the process.** Tasks live in the SDK's in-memory store, so `GetTask`
  after a restart answers `TaskNotFoundError` even though the run's checkpoints exist.
  Rebuilding a run from its checkpoints is **P3-B**. A Postgres task store would be a
  write to Postgres from app code, which `CLAUDE.md` routes through `memory-core`. That is
  not worth a new adapter for a store P3-B makes redundant.
- **OAuth 2.0 client credentials, OpenID Connect and mTLS.** A local demo cannot exercise
  any of them without adding an authorization server or a CA. Bearer is chosen so that
  replacing an opaque token with a JWT later does not change the header or the card's
  scheme. **No PRD owns this.**
- **TLS.** A2A §7.1 makes HTTPS a MUST in production, and nothing here is deployed. The
  proposed CTL-ACC-03 row records this as `not-applicable`, citing ADR 0003's rationale.
  **No PRD owns TLS termination.**
- **Per-session authorization on `POST /runs`.** That contract lets the client choose its
  `sessionId` (`run-request.schema.ts:12`), and an authenticated caller can still name any
  session. Scoping it would change the ids the evaluation harness and the inspector read.
  **No PRD owns this; it is stated as a residual in the ADR.**
- **User login for the console.** Its nginx holds a service credential; anyone who reaches
  port 8080 uses it. **No PRD owns this.**
- **Cancelling a running task.** `CancelTask` on a non-terminal task answers
  `TaskNotCancelableError` (`-32002`). A run stopped between `reflect`'s Postgres and Neo4j
  writes leaves a partial write that the architecture makes safe only under replay
  (`.context/architecture.md`, "The two writes are sequential, not atomic"), and nothing
  replays a cancelled run. **No PRD owns this.**
- **`INPUT_REQUIRED`, extended cards, HTTP server spans, and this agent calling others.**
  None has a consumer. **No PRD owns them.**
- **The ADK mapping.** **P5-B.**

## Design

### Where it lives

In `apps/agent-service`, as `src/a2a/`, and not as a new app. A separate A2A app would call
`/runs` over HTTP. It would need either the final state on the stream, which is a contract
change, or a second round trip. It would also be a second service to authenticate, and a
place where the task id and the run id could disagree. In-process, the executor calls
`RunsService` directly and a task id _is_ a run id.

```
apps/agent-service/src/a2a/
  a2a.module.ts            # provides A2A_REQUEST_HANDLER, CARD_SIGNER, CREDENTIALS
  agent-card.ts            # buildAgentCard(config) — the card, unsigned
  card-signing.ts          # loadSigningKeys(), kid = RFC 7638 thumbprint, jwks()
  run-executor.ts          # AgentExecutor: task ↔ run, events ↔ graph updates
  session-id.ts            # contextSessionId(principal, contextId) — UUIDv5
  history.ts               # rebuildHistory(repo, sessionId) — sorted, contiguity-checked
  mount.ts                 # mountA2a(app): card, jwks, JSON-RPC handler
apps/agent-service/src/auth/
  credentials.ts           # parseCredentials(env) — SERVICE_CREDENTIALS
  require-credential.ts    # Express middleware; 401 + WWW-Authenticate
  trace-context.ts         # propagation.extract into the request's context
apps/agent-service/test/a2a.e2e-spec.ts
scripts/a2a-keygen.mjs     # one-shot key generation for compose
scripts/tck-auth-proxy.mjs # adds the bearer header the TCK cannot send
scripts/tck-expected.txt   # the TCK tests expected to fail, one reason each
```

`main.ts` mounts the auth middleware and the A2A routes with `app.use` after
`NestFactory.create` and before `listen`. They are Express handlers, not controllers, so
the global pipe at `main.ts:25` does not touch them. For the same reason `mount.ts`
supplies the correlation id itself, with the rule `logging.interceptor.ts:16-34` uses, and
runs the handler inside `runWithCorrelationId`. Providers are injected by explicit token
(`.context/conventions.md`, Error Handling).

### Protocol surface

| Item                        | Value                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Binding                     | `JSONRPC` at `${A2A_PUBLIC_URL}/a2a/jsonrpc`, `protocolVersion` `1.0`, and the same URL again at `0.3` |
| Card                        | `/.well-known/agent-card.json`, `Cache-Control` and `ETag` from the SDK's `agentCardHandler`           |
| Keys                        | `/.well-known/jwks.json`, public keys only                                                             |
| Capabilities                | `streaming: true`, `pushNotifications: false`, `extendedAgentCard: false`                              |
| Skill                       | one, `answer-with-memory`: answers from session history and the semantic store                         |
| Input / output modes        | `text/plain` in; `text/plain` and `application/json` out                                               |
| Methods served              | `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask` (and their v0.3 names)     |
| Methods answered with error | push-notification config methods (`-32003`), `GetExtendedAgentCard` (`-32007`)                         |

`A2A_PUBLIC_URL` defaults to `http://localhost:3000`. Compose sets it to the gateway's URL,
and the gateway's `pathFilter` (`apps/gateway/src/routes/runs.route.ts:15`) grows from
`'/runs'` to `['/runs', '/a2a', '/.well-known']`.

**v0.3 is in scope** because ADK for TypeScript 2.1.0 speaks it. The SDK routes by method
name (`message/send` goes to the v0.3 dispatcher). It serves a v0.3-shaped card to a
request with no `A2A-Version` header and sets `Vary: A2A-Version`. The v0.3 card must
carry either a signature that verifies over that shape or none. It must never carry a v1.0
signature that fails. Which of the two the SDK produces is found out by running, and the
criterion below accepts either.

### Tasks, contexts, runs and sessions

| A2A                        | Here                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId` (server-minted)   | `runId`, and so the checkpointer's `thread_id`. `RunsService` takes an optional `runId` and mints one only when none is passed (`runs.service.ts:282`). |
| `contextId`                | not the `sessionId` directly: `sessionId = UUIDv5(A2A_SESSION_NAMESPACE, principal + "\n" + contextId)`                                                 |
| message in a context       | one new task, one run; history rebuilt from episodic memory                                                                                             |
| message naming a done task | `UnsupportedOperationError` (`-32004`); every task here ends terminal                                                                                   |
| task owner                 | the authenticated principal, as the SDK `User.userName`; `InMemoryTaskStore` scopes `GetTask`/`ListTasks` by it                                         |

**Why derive the session id.** If `contextId` were the `sessionId`, any principal who learned
another's context id would get that conversation's history rebuilt into its own prompt,
and retrieval scoped to it (`.context/architecture.md`, Semantic Memory). A name-based UUID
over principal and context gives each principal its own session namespace with no lookup
table. It also accepts any client-supplied `contextId` string, where §3.4.1 would
otherwise require rejecting a non-UUID. `A2A_SESSION_NAMESPACE` is a constant in
`session-id.ts`, not configuration; changing it orphans every A2A session.

**History.** `rebuildHistory` calls `findBySession` with a limit above the context's turn
count, sorts by `turnIndex`, and requires indices `0..n-1` with no gap. The run request is
that history plus the new user message. This is a read through `memory-core`. The only
writes are still `reflect`'s, which is what `CLAUDE.md`'s first two rules require. A gap,
or a context with more turns than the limit, fails the task with a status message rather
than letting the collision described in Problem drop the new turn. Two messages in one
context at once would both read _n_ turns and both write turn _n_, and the second would be
dropped. `run-executor.ts` therefore serializes runs per session with an in-process lock.
On the stub memory axis, `findBySession` returns nothing, so every A2A message is a
single-turn conversation there.

**SDK task ids.** The spike's task ids were UUIDs. `RunResponseSchema` requires one
(`run-response.schema.ts:11`). If the SDK can mint a non-UUID id, the executor rejects the
task rather than inventing a second id. This is checked in the first commit.

### Execution and streaming

`RunsService` gains one private async generator, `runUpdates`, that yields
`{ node, update }` and returns the folded final state. It is the loop now duplicated at
`runs.service.ts:324-330` and `:358-365`. `stream()`, `executeTraced()` and the A2A executor
all consume it, so the three paths cannot drift. `POST /runs/stream`'s wire format does not
change.

| Graph                       | A2A event                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| before the invoke           | `Task`, `TASK_STATE_SUBMITTED`, history = the user message                                                                                       |
| each node update            | `TaskStatusUpdateEvent`, `TASK_STATE_WORKING`, `metadata.node` = the node name                                                                   |
| after `egress`              | artifact `answer` (text: the last assistant message); artifact `run` (data: `runId`, `outcome`, `tokenCounts`, `messageCount`, `retrievedCount`) |
| then                        | `TASK_STATE_COMPLETED`; an `outcome` of `partial` is still completed, and says so in `metadata.outcome`                                          |
| a node throws after retries | `TASK_STATE_FAILED` with an agent message naming the node, and not the error text                                                                |

The failure message follows the rule in `.context/conventions.md` that 5xx payloads are
never forwarded. The error itself is logged with the correlation id and the run id.
`POST /runs/stream` still forwards `error.message` (`runs.service.ts:381`), which is out of
scope here. `messageCount` exists so that the multi-turn criterion can be checked from
outside the process.

### Authentication

**Scheme.** HTTP `Bearer` (RFC 6750) carrying an opaque token. The card declares:

```jsonc
"securitySchemes": {
  "bearer": { "httpAuthSecurityScheme": { "scheme": "Bearer",
    "description": "Opaque service token issued out of band" } }
},
"securityRequirements": [{ "schemes": { "bearer": { "list": ["agent.invoke"] } } }]
```

`agent.invoke` is a role name. OpenAPI 3.1 and 3.2, on which A2A's `SecurityScheme` is
modelled (`a2a.proto`, `message SecurityScheme`), allow one for schemes other than OAuth:
"the array MAY contain a list of role names which are required for the execution". It is
also what keeps the SDK's canonical form and RFC 8785's identical, as the spike showed.
An empty list would leave the requirement outside the signature.

**Credentials.** `SERVICE_CREDENTIALS` is a comma-separated list of `principal:sha256hex`.
The service holds digests, never tokens. The middleware hashes the presented token and
compares it with `crypto.timingSafeEqual` against each digest. On a match it attaches the
principal. On no match, or no header, it answers `401` with
`WWW-Authenticate: Bearer realm="agent-service"`. It logs the principal and never the
token. It covers `/runs`, `/runs/stream` and `/a2a/*` — and, amended at P3-E's review on
2026-09-26, `/fhir/*` and `/review/*` once P3-D and P3-E add them — and exempts `GET /health`,
`/.well-known/agent-card.json` and `/.well-known/jwks.json` — discovery has to be anonymous.

**Enforced at the service, not the gateway.** The service publishes its port on the host
(`docker-compose.yml:39-40`), so authentication at the gateway alone would leave the
resource it protects reachable around it. The gateway forwards the `Authorization` header.
`http-proxy-middleware` passes request headers through, and a criterion checks it rather
than assuming it.

**The same three-state rule as the model and memory axes.** With `SERVICE_CREDENTIALS`
unset, the service runs **open**. It logs `auth.open` at `warn` on boot, and the card
declares no `securitySchemes` and no `securityRequirements`, so it tells the truth about
the endpoint. The README quickstart keeps working on a clone with no `.env`
(`README.md:121-123`). With the variable malformed, the service exits 1 in about a second,
naming it. With it set, every covered route requires a token. Two alternatives were
rejected. Refusing to boot without credentials breaks the quickstart that P0-A made a
requirement. A built-in default token is a default credential (CWE-1392) and is worse than
an explicit open mode. This is the decision a reviewer will question first. It goes in the
ADR with the alternatives. In open mode every caller is the principal `anonymous`, so task
ownership and session scoping collapse into one namespace. The card, which declares no
security, is what tells a caller that.

**Compose.** `SERVICE_CREDENTIALS` holds digests for two principals, `console` and `tck`.
The console's nginx sends `Authorization: Bearer ${CONSOLE_SERVICE_TOKEN}` on `/api/`
(`apps/console/nginx.conf:12-13` today), through nginx's `envsubst` template support, so
the token never reaches the browser bundle. The token values are demo values in the
compose file, the same standing as `POSTGRES_PASSWORD: postgres` beside them.

**CORS.** `app.enableCors()` (`main.ts:26`) is removed. The console reaches the service
same-origin through nginx or the Vite proxy (`apps/console/vite.config.ts:8-14`). With
bearer tokens in play, `Access-Control-Allow-Origin: *` only helps a page that should not
hold one.

### Card signing and keys

- **Algorithm.** ES256 on P-256, the spec's example and the SDK sample's curve.
- **Where the key lives.** `A2A_CARD_SIGNING_KEYS` is a comma-separated list of paths to
  PKCS#8 PEM files. The process reads them at boot and never logs them. With the variable
  unset, the card is served **unsigned** and the service logs `a2a.card.unsigned`. An
  ephemeral key generated at boot would produce a signature that no one can pin, which is
  worse than none.
- **`kid`** is the RFC 7638 JWK thumbprint of the public key, so there is no second name
  to keep in sync. **`jku`** is `${A2A_PUBLIC_URL}/.well-known/jwks.json`.
- **Rotation.** Every configured key signs, so the card carries one signature per key; the
  spec allows several "to support key rotation" (§8.4.3). The JWKS publishes every
  configured public key. To rotate: add the new file, wait out the card's
  `Cache-Control: max-age`, remove the old one.
- **Compose.** A one-shot `a2a-keygen` service runs `scripts/a2a-keygen.mjs`, which writes
  a P-256 key into a named volume if none is there. `agent-service` depends on it
  completing. **No private key is committed**: tests generate keys in-process with
  `jose.generateKeyPair`, and a criterion checks the tree for PEM private-key headers.
- **Signing** uses the SDK's `generateAgentCardSignature`, because SDK verifiers in
  JavaScript and Python are what callers run. **Verification in tests** uses two
  verifiers: the SDK's `verifyAgentCardSignature`, and `jose.flattenedVerify` over the
  output of `canonicalize` (RFC 8785, maintained by one of its authors). A card on which
  the two disagree is a failing test. That is the regression check for the divergence the
  spike found.

### Trace context

`trace-context.ts` runs `propagation.extract(context.active(), req.headers)` on the
covered routes and runs the handler inside the result. The NodeSDK at
`packages/telemetry/src/otel.setup.ts:18-23` installs the W3C propagator by default. The
gateway injects `traceparent` in its existing `proxyReq` hook (`runs.route.ts:18-29`).
Without P2-C's root span, the extracted context parents each `agent.node.*` span directly.
With it, it parents `invoke_agent`. The criterion asserts only the shared trace id, which
holds either way, so P2-C is not a predecessor.

### Conformance testing

Three layers, and each criterion below names the axis it runs on.

1. **Service tier** (`test:service`, Jest, model stub, memory stub). A new
   `test/a2a.e2e-spec.ts` covers the card, signing and tamper cases, auth on every route,
   `SendMessage`, the streamed event order, failure, ownership, version handling and trace
   id.
2. **Compose tier** (`e2e.yml`, `browser-e2e` job, after `docker compose --profile full up`;
   model stub, memory live). A short script checks what needs real stores: the task id
   has checkpoints under it, and a second message in a context sees three messages. It
   also runs the Playwright suite with authentication enforced.
3. **TCK** (same job, same axes). The job runs `a2a-tck` pinned to a commit, with
   `--transport jsonrpc --level must`, through `scripts/tck-auth-proxy.mjs` — about twenty
   lines that add `Authorization: Bearer $TCK_TOKEN` because the TCK cannot. In CI,
   `A2A_PUBLIC_URL` points at the proxy so that the card's interface URL routes the TCK
   through it. `scripts/tck-expected.txt` lists each test expected to fail by pytest node
   id, with a one-line reason. The spike's five are all "scenario-scripted content". The
   step reads the JUnit report and fails on a failure not in the list **and** on a listed
   test that passes, so the list cannot go stale in either direction. The job uploads
   `compatibility.json`.

Running the TCK against a scripted executor instead would test the SDK and the mount, and
not this agent. It was rejected. The real executor on the stub model axis passes or fails
on what this server does, and the five exceptions stay visible in a file.

### Records this PRD updates

- **An ADR** — "Service authentication: bearer credentials at the service, open when
  unconfigured". It records the rejected alternatives and the `/runs` session residual.
- **`docs/STATUS.md`** gains three rows: the A2A endpoint, the signed card, and service
  authentication. Each names its test.
- **P4-A's catalogue.** P5-A cannot satisfy CTL-ACC-01 as worded, because "encrypted in
  transit" is out of scope. It proposes three rows in its place:
  - **CTL-ACC-01**: "Every request to the external surface, except discovery and health,
    is authenticated". `implemented`, anchored to the 401 tests.
  - **CTL-ACC-02**: "An A2A caller reaches only the tasks and conversations it created".
    `implemented`, anchored to the ownership tests.
  - **CTL-ACC-03**: "Traffic is encrypted in transit". `not-applicable`, with ADR 0003's
    rationale and A2A §7.1.

  If `governance/controls.yaml` exists when this lands, P5-A edits it. If it does not, P4-A
  writes these rows. That is the rule P4-A already applies to rows other PRDs are editing
  in flight: whichever lands second rebases (`P4-A-controls-as-code.md:418-421`). The
  order matters for one reason. P4-A's checker fails a `planned` control whose owner is
  `shipped`, so CTL-ACC-01 cannot be left `planned` under P5-A once this ships.

## Acceptance criteria

- [ ] `GET /.well-known/agent-card.json` answers `200` with a card that round-trips through
      the SDK's `AgentCard.fromJSON` unchanged. It declares a `JSONRPC` interface at `1.0`
      and one at `0.3`, `streaming: true` and `pushNotifications: false`. _Service tier;
      model stub, memory stub._
- [ ] With two keys in `A2A_CARD_SIGNING_KEYS`, the card carries two signatures. Each
      verifies with `verifyAgentCardSignature` and with `jose.flattenedVerify` over
      `canonicalize(card without signatures)`, against the JWKS entry matching its `kid`.
      Changing the interface URL, or deleting `securityRequirements`, fails both verifiers
      for both signatures. With the variable unset, the card has no `signatures` and the
      boot log contains `a2a.card.unsigned`. _Service tier; keys generated in the test._
- [ ] A card fetched with no `A2A-Version` header carries either no signatures or
      signatures that verify over the card as served. _Service tier._
- [ ] With `SERVICE_CREDENTIALS` set, `POST /runs`, `POST /runs/stream` and
      `POST /a2a/jsonrpc` each answer `401` with `WWW-Authenticate: Bearer realm="agent-service"`
      to a missing token and to a wrong one. `GET /health` and both `/.well-known/`
      documents answer `200` with no token. _Service tier._
- [ ] With it unset, the service boots, logs `auth.open`, serves a card with no
      `securitySchemes`, and both README quickstart curls return `200`. With it set to
      `nocolon`, the service exits 1 within two seconds with a message naming
      `SERVICE_CREDENTIALS`. _Service tier for the first; a process test for the second._
- [ ] `SendStreamingMessage` emits, in order: a `Task` in `SUBMITTED`; one `WORKING` status
      per node, whose `metadata.node` values equal the node sequence `executeTraced` reports
      for the same input; the `answer` and `run` artifacts; `COMPLETED`. The stream then
      closes. With `reflect` throwing on every attempt, it ends in `FAILED` with a message
      that names `reflect` and does not contain the thrown message. _Service tier; model
      stub, memory stub._
- [ ] `POST /runs/stream`'s frames are unchanged. The existing
      `'emits a terminal error frame and closes the stream'` spec passes without edits.
      _Service tier._
- [ ] Principal `b` calling `GetTask` on a task principal `a` created gets `-32001`, and
      `ListTasks` for `b` does not include it. _Service tier._
- [ ] A `SendMessage` with no `A2A-Version` header and method `message/send` completes a
      task. _Service tier._
- [ ] A `SendMessage` carrying `traceparent` with trace id _T_ produces `agent.node.*`
      spans whose trace id is _T_, read from an in-memory exporter. _Service tier._
- [ ] On the compose stack, a completed task's `id` has at least one row in the
      checkpointer's `checkpoints` table under `thread_id = id`. _Compose tier; model stub,
      memory live._
- [ ] On the compose stack, a second `SendMessage` in the same `contextId` from the same
      principal reports `messageCount: 3` in its `run` artifact. The same `contextId` from
      the other principal reports `messageCount: 1`. _Compose tier; memory live. On memory
      stub both report 1, and the README says so._
- [ ] `e2e.yml` runs the TCK at a pinned commit with `--transport jsonrpc --level must`
      through the auth proxy against the compose stack, with authentication enforced. The
      step fails when a test not in `scripts/tck-expected.txt` fails, and when a listed
      test passes. It uploads `compatibility.json`. _Compose tier; model stub, memory live._
- [ ] The Playwright suite in `e2e.yml` passes against the compose stack with
      authentication enforced, and the console bundle in `apps/console/dist` contains no
      service token.
- [ ] A preflight `OPTIONS /runs` with `Origin: https://evil.example` gets no
      `Access-Control-Allow-Origin` header. _Service tier._
- [ ] `git grep -l -E 'BEGIN (EC |RSA )?PRIVATE KEY'` returns nothing.
- [ ] The ADR exists and the ADR index lists it. `docs/STATUS.md` has the three rows. The
      CTL-ACC rows are as proposed, in whichever of P4-A and P5-A lands second.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Risks and open questions

- **Open when unconfigured may be the wrong default for this audience.** It keeps the
  quickstart and matches the repository's axis rule, but a reviewer skimming `main.ts` sees
  a service that serves without credentials. The mitigations are the `warn` log, a card
  that declares no security, and the compose stack running authenticated. **Open
  question for review:** keep open mode, or make the quickstart send a token and refuse
  to boot without one. **Decided at review, 2026-09-26: open mode stays.** The repository's
  rule is that an unconfigured axis runs and a configured-but-broken one exits; refusing to
  boot would make the no-`.env` quickstart the exception. The `warn` line and the
  authenticated compose stack are what a reader sees instead.
- **CTL-ACC-01 as worded cannot be closed by this PRD.** The split above changes P4-A's
  accepted catalogue. **Open question for review:** accept the split, or keep one row and
  leave it `planned` with no owner for the TLS half. It changes P4-A's scope, not this one's.
  **Decided at review, 2026-09-26: split**, with encryption in transit `not-applicable` on
  the stated ground that nothing is deployed and TLS terminates at the deploying
  organization's ingress. P4-A's implementation or this one, whichever lands second, makes
  the catalogue edit.
- **The SDK's canonicalization departs from the spec.** It drops every empty value,
  including `REQUIRED` ones and an empty requirement list. The design avoids every empty
  value, and the two-verifier test catches a card that stops doing so. If the SDK is
  changed to match the spec, this card is unaffected. The divergence is worth reporting to
  `a2aproject/a2a-js`; this PRD does not file it.
- **The TCK is pre-release and scenario-driven.** The claim this PRD can make is "passes
  the TCK's MUST-level JSON-RPC tests at commit X, except the tests listed with reasons".
  It is not "A2A certified", and no certification exists. The TCK does not test card
  signing (CARD-SIGN-001 to 004 are "To Do") or authentication. The two-verifier test and
  the 401 tests are this repository's own. A TCK update can add failures, so the commit
  is pinned and moving it is a deliberate change.
- **On the stub model axis, A2A answers are canned.** The TCK and the compose checks
  measure the protocol and the memory wiring, not answer quality. No criterion here runs
  on the live model axis. A task's text depends on the model, and the harness already
  measures that (P1-A).
- **Single-instance assumptions.** The task store and the per-session lock live in one
  process. Two replicas would lose tasks between them and could race on a session's next
  turn index. That is acceptable for a service that is not deployed. It is written down so
  that "scale it out" is recognised as a change that needs a design.
- **The v0.3 path is a second card shape and dispatcher.** It exists for one caller, ADK
  for TypeScript at 2.1.0. If ADK moves to SDK 1.x, the compat flag should come out with
  its criterion. P5-B's trial is the first thing that would notice.
- **Size.** The index had this at `M`. It is `L`. The A2A mount is the smaller part. Around
  it sit authentication on three routes plus the gateway, nginx and compose, key handling,
  a refactor shared by three run paths, history reconstruction, and a TCK job — and none of
  that code has run. Per `.agents/prd-author.md`, code that has never run is sized as
  unknown.
- **Nest middleware order.** The spike showed Express handlers mounted with `app.use`
  answering inside Nest. It did not show that a middleware mounted that way runs before a
  Nest controller. The `401` criterion on `POST /runs` is what proves it.

## References

- A2A Protocol Specification v1.0.1 — <https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md>,
  §3.4 (contexts and tasks), §3.6 (versioning), §5.3–5.4 (method and error mappings), §7
  (authentication), §8.2 (discovery), §8.4 (card signing); normative proto at
  <https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto>.
- `@a2a-js/sdk` 1.2.1 — <https://github.com/a2aproject/a2a-js>, `src/signature.ts`,
  `src/server/owner_resolver.ts`, `docs/compatibility-v0_3.md`.
- A2A TCK — <https://github.com/a2aproject/a2a-tck>, commit `263b9cf`; `README.md`,
  `scenarios/core_operations.feature`, `backlog/tasks/task-29`.
- RFC 7515 (JWS), RFC 7517 (JWK), RFC 7638 (JWK thumbprint), RFC 8785 (JCS), RFC 6750
  (Bearer), RFC 9562 §5.5 (name-based UUID).
- OpenAPI Specification 3.2.0, Security Requirement Object — <https://spec.openapis.org/oas/v3.2.0.html>.
- `google/adk-js` `core/package.json` at `adk-v2.1.0` — the `@a2a-js/sdk ^0.3.10`
  dependency.
- Google Cloud, _Introducing Gemini Enterprise Agent Platform_, 2026-04-22 —
  <https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform>.
- `docs/prd/P4-A-controls-as-code.md` (CTL-ACC-01), `docs/prd/P2-C-otel-genai-semantics.md`
  (propagation hand-off), ADR 0003 (the ePHI boundary), ADR 0001 (why resume is not exactly-once).
