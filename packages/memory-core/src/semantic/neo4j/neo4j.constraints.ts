import type { Driver } from 'neo4j-driver';
import { createLogger } from '@repo/telemetry';

const logger = createLogger('memory-core');

/**
 * Uniqueness constraints and session indexes for the knowledge graph, applied
 * at boot.
 *
 * `MERGE` is not safe under concurrency without the constraints: two
 * transactions can each fail to find the node and each create it, which is
 * precisely the duplicate the writer's idempotency is supposed to rule out.
 * The constraint is what makes `MERGE` an upsert rather than a race.
 *
 * The two range indexes serve the session scope every graph read carries
 * (P2-D's M1): `:Fact(sessionId)` for the facts a session owns, and
 * `RELATES_TO(sessionId)` for the edges it wrote.
 *
 * Idempotent — `IF NOT EXISTS` on each, so this runs on every boot.
 */
const CONSTRAINTS = [
  'CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (c:Concept) REQUIRE c.id IS UNIQUE',
  'CREATE CONSTRAINT fact_hash IF NOT EXISTS FOR (f:Fact) REQUIRE f.contentHash IS UNIQUE',
  'CREATE INDEX fact_session IF NOT EXISTS FOR (f:Fact) ON (f.sessionId)',
  'CREATE INDEX relates_to_session IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON (r.sessionId)',
] as const;

export async function ensureSemanticConstraints(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    for (const statement of CONSTRAINTS) {
      await session.run(statement);
    }
    logger.info({ msg: 'neo4j.constraints.ready', count: CONSTRAINTS.length });
  } finally {
    await session.close();
  }
}
