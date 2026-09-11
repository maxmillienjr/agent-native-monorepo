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

## Add a New Graph Node

1. Create `apps/agent-service/src/agent/nodes/<name>.node.ts`.
2. Implement the signature:
   ```typescript
   export async function <name>Node(state: AgentState): Promise<Partial<AgentState>>
   ```
3. Wrap the body in an OTel span:

   ```typescript
   import { getTracer } from '@repo/telemetry';
   const tracer = getTracer('agent-service');

   return tracer.startActiveSpan('agent.node.<name>', async (span) => {
     try {
       // node logic
       return {/* partial state updates */};
     } finally {
       span.end();
     }
   });
   ```

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
   success.
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
