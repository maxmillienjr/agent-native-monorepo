import pg from 'pg';

/**
 * A pool whose every session is read-only, for a reader that must make no
 * write: `audit:replay` reads a run record and its checkpoints through it.
 *
 * The guarantee is the server's, not a promise of the caller's code. With
 * `default_transaction_read_only` on, Postgres refuses an `INSERT`, `UPDATE`,
 * `DELETE` or DDL in any transaction the session opens, so a replay that
 * reached a writer by mistake would fail rather than change the store it is
 * auditing. It also does none of what `createPgvectorPool` does on connect,
 * which creates an extension.
 */
export function createReadOnlyPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, options: '-c default_transaction_read_only=on' });
}
