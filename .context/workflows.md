# Workflows

Step-by-step guides for common development tasks in this monorepo.

## Propose a Change

Non-trivial work is described before it is built. In Claude Code, `/prd <id>` runs this
workflow for you; the steps below are the tool-agnostic version.

1. Read `docs/prd/README.md`. The change you have in mind may already be a PRD with a
   decided approach and known dependencies.
2. If it is not, copy `docs/prd/_TEMPLATE.md` to `docs/prd/<ID>-<slug>.md` and fill it in.
   Use `.agents/prd-author.md` if delegating to a subagent.
3. Add a row to the index table in `docs/prd/README.md`. The `size` and `status` there must
   match the file's frontmatter — `yarn lint:docs` enforces it.
4. Keep `depends_on` and `blocks` mutual. The lint enforces that too, for PRDs that have
   files.
5. If the change settles a question a reviewer would reasonably ask "why," write an ADR in
   `docs/adr/` and add it to that index.
6. Open a GitHub issue only when work actually starts, using the PRD issue template. The
   backlog lives in the index; the tracker is for work in flight.

## Add or Change a Control

`governance/controls.yaml` is the catalogue; `governance/CONTROLS.md` is generated from it.

1. **Read the clause before mapping to it.** A `ref` must be a key of its framework's
   `clauses` map. To map to a clause that is not there yet, add it with its text copied
   from the source, not paraphrased. A new edition of a framework is a new registry id,
   never an edit to an existing one — OWASP's 2026 LLM list renumbers the 2025 one, and
   `LLM06:2025` and the 2026 `LLM06` are different risks.
2. **Pick the status by what backs it, not by what the code does.**
   - `implemented` needs at least one `test` or `ci` anchor. A `symbol` or `doc` anchor
     alone does not make a control implemented, because neither fails when the control
     stops holding.
   - `procedural` needs a `doc` anchor naming the written rule a person applies, and no
     executable anchor.
   - `planned` needs an `owner`: a PRD id in the index that is not `shipped`. If that PRD
     has a file, add the control id to its `controls:` frontmatter in the same change.
   - `not-applicable` needs a `rationale` of at least 40 characters, printed in the matrix.
3. **Anchor by name.** `symbol` is `{ file, name }` with `name` a declaration or
   `Class.member`. `test` is `{ file, name, tier }` with `name` the exact title. `ci` is
   `{ workflow, job, run? }`. `doc` is `{ file, heading }`. Paths are exact
   repository-relative paths, and a `:NN` line anchor is rejected.
4. Run `yarn controls:matrix` to regenerate `governance/CONTROLS.md`, then `yarn lint:docs`.
   The lint names every problem at once, each with the control id.
5. **When a PRD ships a `planned` control**, move the row to `implemented` with its
   evidence in that PRD's pull request. The lint fails a `planned` row whose owner is
   `shipped`, so the row cannot be left behind.

## Add a New Graph Node

1. Create `apps/agent-service/src/agent/nodes/<name>.node.ts`.
2. Implement the signature:
   ```typescript
   export async function <name>Node(state: AgentState): Promise<Partial<AgentState>>
   ```
3. Wrap the body in the node span helper:

   ```typescript
   import { withNodeSpan } from '@repo/telemetry';

   return withNodeSpan('<name>', async (span) => {
     span.setAttribute('run_id', state.runId);
     // node logic
     return {/* partial state updates */};
   });
   ```

   It names the span `agent.node.<name>`, ends it, and on a throw records `error.type` and
   ERROR status before rethrowing. The span is a child of the run's `invoke_agent` root, so
   the node needs nothing else to join the run's trace. Two rules come with it:
   - **A new span attribute goes on `ALLOWED_SPAN_ATTRIBUTES`** in
     `packages/telemetry/src/genai.ts`, or `spans.test.ts` and every `yarn eval` fail. The
     list is where a reviewer asks whether the value is content — anything the model or the
     user wrote, an extracted entity id included — and content never goes on a span.
   - **A model call is not the node's to record.** Usage belongs on the inference span the
     client wrapper opens (`withInferenceSpan`); a copy on the node span is counted twice by
     anything summing `gen_ai.usage.*`.

4. Wire the node into `apps/agent-service/src/agent/graph/graph.ts`:
   - Add the node to the `StateGraph`.
   - Define edges to/from the new node.
   - **The node name must not match any channel in `AgentStateAnnotation`.** LangGraph
     rejects the collision from inside `addNode` — "`<name>` is already being used as a
     state attribute (a.k.a. a channel), cannot also be used as a node name" — and the
     graph is built per request, so this surfaces as a 500 on every call rather than a
     failure at startup. If a node needs a state field of the same name, rename the
     channel: node names are public vocabulary (SSE `StreamEvent.node`, the
     `agent.node.<name>` span, the console's colour map, the topology diagrams) and the
     channel is not. State fields live in `graph/state.ts` and in `WorkingMemorySchema` in
     `packages/memory-core`; rename both, or the type keeps a field that always reads
     `undefined`.
5. Add a unit test in `apps/agent-service/src/agent/nodes/<name>.node.test.ts`.
6. Run `yarn turbo typecheck && yarn turbo lint` — then `yarn turbo test:unit` and
   `yarn turbo test:service`. The first two cannot catch a graph that fails to build; only
   something that calls `buildAgentGraph` can, which is what
   `src/agent/graph/graph.test.ts` does.

## Add a New Package

1. Create `packages/<name>/` with this structure:
   ```
   packages/<name>/
   ├── src/
   │   └── index.ts
   ├── package.json
   ├── tsconfig.json
   ├── eslint.config.js
   └── vitest.config.ts
   ```
2. Set `package.json`. Every existing package matches this shape, and the two easy
   omissions both fail quietly: `module` is `NodeNext`, so leaving `"type": "module"` out
   emits CommonJS into a repository where every other workspace is ESM, and leaving the
   `lint` script out means `yarn turbo lint` runs no task for the package and still reports
   success. Add an `exports` map only for an entry point that must stay out of the barrel;
   `@repo/determination` is the one package that has one, and why is in
   `.context/conventions.md`.
   ```json
   {
     "name": "@repo/<name>",
     "private": true,
     "version": "0.0.0",
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc --build",
       "clean": "rm -rf dist *.tsbuildinfo",
       "typecheck": "tsc --noEmit",
       "lint": "eslint src/",
       "test:unit": "vitest run"
     },
     "devDependencies": {
       "@repo/eslint-config": "workspace:*",
       "@repo/tsconfig": "workspace:*",
       "eslint": "^9.39.5",
       "typescript": "^5.7.0",
       "vitest": "^4.1.11"
     }
   }
   ```
3. Set `tsconfig.json` to extend the appropriate base:
   ```json
   {
     "extends": "@repo/tsconfig/base.json",
     "compilerOptions": { "outDir": "dist", "rootDir": "src" },
     "include": ["src"]
   }
   ```
4. `eslint.config.js` is one line — `export { default } from '@repo/eslint-config';` — and
   `vitest.config.ts` sets `test.include` to `['src/**/*.test.ts']`, because unit tests are
   co-located with their source.
5. The package is auto-discovered by the `"workspaces": ["packages/*"]` glob.
6. Run `yarn install` to link, then `yarn turbo build` to verify. `yarn workspaces list` is
   what confirms the glob picked it up.
7. A workspace that imports the package declares it as a `workspace:*` dependency, even
   though the import resolves without one. `nodeLinker: node-modules` symlinks every
   workspace into `node_modules/@repo/`, so an undeclared import compiles locally against
   a `dist/` built earlier, and can fail on a clean clone: Turbo orders `typecheck` after
   `^build` by the declared graph only.

## Add a New Memory Adapter

1. Create the adapter under `packages/memory-core/src/<tier>/`.
2. Implement the relevant interface:
   - Episodic: `EpisodicRepository`
   - Neo4j: `Neo4jWriter`, `Neo4jReader`
   - pgvector: `PgvectorWriter`, `PgvectorReader`
   - Retrieval: `RetrievalFacade`
3. Enforce idempotent write semantics:
   - Neo4j: Always use `MERGE`, never `CREATE`.
   - pgvector: Always upsert on `content_hash`, never bare `INSERT`.
4. Export from `packages/memory-core/src/index.ts`.
5. Add integration tests in `packages/memory-core/test/`:
   - Run against real databases, never mocks. They come from `docker-compose.yml` locally
     and from service containers in `e2e.yml`; the suites read `DATABASE_URL` and
     `NEO4J_URI` and skip when those are unset. This repo has never used `testcontainers`,
     despite older wording that said so.
   - Verify write/read round-trip.
   - Verify idempotency (run twice, assert no duplicates).
6. Run `yarn turbo test:integration` to verify.

## Add an HTTP Route to agent-service

Two things apply to every controller today. Neither is visible from the controller you are
writing.

1. **The request-body pipe is global.** `main.ts` calls
   `app.useGlobalPipes(new ZodValidationPipe(RunRequestSchema))`, so a new route's
   `@Body()` is parsed as a `RunRequest` and anything else gets `400` naming `sessionId`.
   `test/runs.e2e-spec.ts` installs the same pipe again. A route with a different body has
   to move the pipe onto `RunsController`'s parameters and delete it from both places. P3-D
   plans that move.
2. **Only `application/json` bodies are parsed.** A body sent with another JSON media type,
   such as `application/fhir+json`, reaches the handler as `undefined`. Register a parser
   for the type in `main.ts`.

Write a service test in `test/` that posts a real body with the real `Content-Type`.
Calling the handler directly bypasses both of the problems above.
