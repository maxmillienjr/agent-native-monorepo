import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  DrizzleCaseRepository,
  InMemoryCaseRepository,
  type CaseRepository,
} from '@repo/memory-core';

/**
 * The prior-authorization case store for this memory axis (P3-E, ADR 0010).
 *
 * Configured, it is Postgres, and a pool that could not connect or migrate has
 * already stopped boot in `PG_POOL`'s factory. Unconfigured, it is an
 * in-process store that loses every case on restart, and the service says so
 * at `warn` once, at boot: an unconfigured axis runs and says what it is
 * running on, a configured and unreachable one exits (P5-A's open-mode
 * pattern). Answering 503 to every referral instead was P3-E's open question
 * 2, and review chose the volatile store, because P3-D's stub-axis criteria
 * return `queued` with no database.
 */
export function selectCaseRepository(
  pool: pg.Pool | null,
  warn: (entry: { msg: string; detail: string }) => void,
): CaseRepository {
  if (pool !== null) return new DrizzleCaseRepository(drizzle(pool));
  warn({
    msg: 'review.cases.volatile',
    detail:
      'No DATABASE_URL: prior-authorization cases are held in this process and lost on ' +
      'restart. A pended request submitted now has no case after the service restarts.',
  });
  return new InMemoryCaseRepository();
}
