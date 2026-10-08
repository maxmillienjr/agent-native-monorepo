import pg from 'pg';

export interface PgvectorConfig {
  connectionString: string;
  /**
   * Hears an error an idle client emits when its server goes away. Defaults to
   * ignoring it: the pool discards that client, and the next query reconnects
   * or fails on its own. What must not happen is no listener at all — see
   * `listenForIdleErrors`.
   */
  onError?: (error: Error) => void;
}

/**
 * Attaches the `error` listener every `pg` pool needs.
 *
 * An idle client whose server terminates it — a Postgres restart, a failover,
 * an idle timeout on a proxy — emits `error` on its pool. With no listener,
 * Node treats that as an uncaught exception and the process exits, so a
 * database restart becomes a service crash rather than a few failed queries.
 */
export function listenForIdleErrors(pool: pg.Pool, onError?: (error: Error) => void): pg.Pool {
  pool.on('error', onError ?? (() => undefined));
  return pool;
}

export async function createPgvectorPool(config: PgvectorConfig): Promise<pg.Pool> {
  const pool = listenForIdleErrors(
    new pg.Pool({ connectionString: config.connectionString }),
    config.onError,
  );

  // Ensure pgvector extension is available
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    client.release();
  }

  return pool;
}
