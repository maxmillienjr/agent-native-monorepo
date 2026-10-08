import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { z } from 'zod';

/** `migrations/` and `roles.sql` resolve the same from `src/` and from `dist/`. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
const ROLES_FILE = fileURLToPath(new URL('../roles.sql', import.meta.url));

/**
 * The ledger's own migration history, beside memory-core's rather than in it,
 * so its schema can be audited and lifted on its own.
 */
export const LEDGER_MIGRATIONS_TABLE = '__ledger_migrations';

/** Serialises two migrators racing on one database. Any constant would do. */
const MIGRATE_LOCK_KEY = 0x6c6d6967; // "lmig"

/** The drizzle-kit journal format, so the files stay ones drizzle-kit can read. */
const JournalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string().min(1) })),
});

/**
 * Applies the ledger's migrations and then `roles.sql`, as the tables' owner.
 *
 * Its own small runner rather than Drizzle's migrator, so the package's
 * runtime dependencies stay `pg`, `zod` and `@repo/determination`, which is
 * what an auditor who lifts it out needs to install. It reads the same
 * journal format, applies each pending file's statements in order in one
 * transaction under an advisory lock, and records a SHA-256 of each file.
 * Unlike Drizzle's, it refuses a migration whose file changed after it was
 * applied, the silent divergence `.context/conventions.md` warns about.
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
  const journal = JournalSchema.parse(
    JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')),
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATE_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER_MIGRATIONS_TABLE} (
         tag text PRIMARY KEY,
         hash text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Map(
      (await client.query(`SELECT tag, hash FROM ${LEDGER_MIGRATIONS_TABLE}`)).rows.map(
        (row: unknown) => {
          const { tag, hash } = z.object({ tag: z.string(), hash: z.string() }).parse(row);
          return [tag, hash] as const;
        },
      ),
    );

    for (const { tag } of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      const sql = await readFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
      // Over the statements, not the comments: the conventions allow a comment
      // to be corrected in place, and never a statement.
      const statements = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      const hash = createHash('sha256').update(statements, 'utf8').digest('hex');
      const recorded = applied.get(tag);
      if (recorded !== undefined) {
        if (recorded !== hash) {
          throw new Error(
            `ledger migration ${tag} has changed since it was applied; a schema change is a new migration`,
          );
        }
        continue;
      }
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim() !== '') await client.query(statement);
      }
      await client.query(`INSERT INTO ${LEDGER_MIGRATIONS_TABLE} (tag, hash) VALUES ($1, $2)`, [
        tag,
        hash,
      ]);
    }
    await client.query(await readFile(ROLES_FILE, 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

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
