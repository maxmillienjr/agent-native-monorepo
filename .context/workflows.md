# Workflows

Step-by-step guides for common development tasks in this monorepo.

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
5. Add a unit test in `apps/agent-service/src/agent/nodes/<name>.node.test.ts`.
6. Run `yarn turbo typecheck && yarn turbo lint` to verify.

## Add a New Package

1. Create `packages/<name>/` with this structure:
   ```
   packages/<name>/
   ├── src/
   │   └── index.ts
   ├── package.json
   └── tsconfig.json
   ```
2. Set `package.json`:
   ```json
   {
     "name": "@repo/<name>",
     "private": true,
     "version": "0.0.0",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc --build",
       "clean": "rm -rf dist *.tsbuildinfo",
       "typecheck": "tsc --noEmit",
       "test:unit": "vitest run"
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
4. The package is auto-discovered by the `"workspaces": ["packages/*"]` glob.
5. Run `yarn install` to link, then `yarn turbo build` to verify.

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
5. Add integration tests using testcontainers in `packages/memory-core/test/`:
   - Spin up real containers (no mocks).
   - Verify write/read round-trip.
   - Verify idempotency (run twice, assert no duplicates).
6. Run `yarn turbo test:integration` to verify.
