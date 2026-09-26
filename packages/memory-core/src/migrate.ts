import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * `migrations/` resolves the same from `src/` under tsx or vitest and from
 * `dist/` in the built package, because both sit one level below the package
 * root.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies every pending migration for `episodes` and `semantic_facts`.
 *
 * This is the only DDL for those two tables. Before it existed the schema was
 * hand-rolled in five places — two integration tests, the eval seed script and
 * `PgPgvectorWriter.ensureTable` — which meant a column could be added to the
 * table a test created and not to the one production would have had.
 *
 * Callers: `apps/agent-service` at boot, before `app.listen`, which is also
 * how every evaluation run gets its schema; and the integration suites in
 * `beforeAll`. Idempotent — Drizzle records applied migrations in
 * `__drizzle_migrations`.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
}
