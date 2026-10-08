import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** `migrations/` and `roles.sql` resolve the same from `src/` and from `dist/`. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
const ROLES_FILE = fileURLToPath(new URL('../roles.sql', import.meta.url));

/**
 * The ledger's own migration history, beside memory-core's rather than in it,
 * so its schema can be audited and lifted on its own.
 */
export const LEDGER_MIGRATIONS_TABLE = '__ledger_migrations';

/**
 * Applies the ledger's migrations and then `roles.sql`, as the tables' owner.
 *
 * Not called by the service: the service connects as `ledger_writer`, which
 * cannot create a table, and must not be able to. `yarn ledger:migrate` and
 * the integration suites call it with an owner's pool.
 *
 * With `writerPassword`, `ledger_writer` is also given `LOGIN` and that
 * password — the local and test path. A deployment issues the credential from
 * its secret store instead.
 */
export async function runLedgerMigrations(
  pool: pg.Pool,
  options: { readonly writerPassword?: string } = {},
): Promise<void> {
  await migrate(drizzle(pool), {
    migrationsFolder: MIGRATIONS_FOLDER,
    migrationsTable: LEDGER_MIGRATIONS_TABLE,
  });
  await pool.query(await readFile(ROLES_FILE, 'utf8'));

  if (options.writerPassword !== undefined) {
    const client = await pool.connect();
    try {
      // A role's password cannot be a bind parameter; the client's own
      // escaping is what quotes it.
      await client.query(
        `ALTER ROLE ledger_writer WITH LOGIN PASSWORD ${client.escapeLiteral(options.writerPassword)}`,
      );
    } finally {
      client.release();
    }
  }
}

/**
 * What a service must check before it appends: the tables exist, and the role
 * it connected as cannot rewrite them.
 *
 * The second half is the one that matters. A ledger written with a role that
 * holds `UPDATE`, or owns the tables, is a ledger its writer can rewrite, and
 * then the chain proves nothing about the service. So the service refuses to
 * start on such a role rather than append through it.
 */
export async function assertWriterRole(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{
    present: boolean;
    can_update: boolean | null;
    can_delete: boolean | null;
    can_truncate: boolean | null;
    is_owner: boolean | null;
    role: string;
  }>(
    `SELECT to_regclass('ledger_entries') IS NOT NULL AS present,
            current_user AS role,
            CASE WHEN to_regclass('ledger_entries') IS NULL THEN NULL
                 ELSE has_table_privilege('ledger_entries', 'UPDATE') END AS can_update,
            CASE WHEN to_regclass('ledger_entries') IS NULL THEN NULL
                 ELSE has_table_privilege('ledger_entries', 'DELETE') END AS can_delete,
            CASE WHEN to_regclass('ledger_entries') IS NULL THEN NULL
                 ELSE has_table_privilege('ledger_entries', 'TRUNCATE') END AS can_truncate,
            CASE WHEN to_regclass('ledger_entries') IS NULL THEN NULL
                 ELSE pg_has_role((SELECT tableowner FROM pg_tables
                                    WHERE tablename = 'ledger_entries' LIMIT 1), 'MEMBER') END AS is_owner`,
  );
  const row = result.rows[0];
  if (row === undefined || !row.present) {
    throw new Error(
      'The ledger database has no ledger_entries table. Run `yarn ledger:migrate` as the owner first.',
    );
  }
  const powers = [
    row.can_update === true ? 'UPDATE' : null,
    row.can_delete === true ? 'DELETE' : null,
    row.can_truncate === true ? 'TRUNCATE' : null,
    row.is_owner === true ? 'ownership' : null,
  ].filter((power): power is string => power !== null);
  if (powers.length > 0) {
    throw new Error(
      `LEDGER_DATABASE_URL connects as ${row.role}, which holds ${powers.join(', ')} on ledger_entries. ` +
        'A ledger its writer can rewrite is not tamper-evident: connect as ledger_writer (roles.sql).',
    );
  }
}
