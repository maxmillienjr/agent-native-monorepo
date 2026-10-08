import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  DrizzleAppealRepository,
  DrizzleCaseRepository,
  InMemoryAppealRepository,
  InMemoryCaseRepository,
  type AppealRepository,
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

/**
 * The appeal store for this memory axis (P3-F), beside the case store it
 * references. Postgres with a pool. Without one, an in-process store built
 * over the in-process case store, sharing its per-case lock, so an appeal and
 * its case are written as one. `selectCaseRepository` has already warned that
 * both are volatile.
 */
export function selectAppealRepository(
  pool: pg.Pool | null,
  cases: CaseRepository,
): AppealRepository {
  if (pool !== null) return new DrizzleAppealRepository(drizzle(pool));
  if (!(cases instanceof InMemoryCaseRepository)) {
    throw new Error(
      'with no DATABASE_URL the case store is in process, and appeals are built over it',
    );
  }
  return new InMemoryAppealRepository(cases);
}
