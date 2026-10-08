import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runLedgerMigrations } from '../src/migrate.js';

/**
 * The integration guard, as memory-core spells it: a missing `DATABASE_URL`
 * skips the suite on a laptop, and fails it by name when
 * `REQUIRE_INTEGRATION_ENV` is set, which the integration job in `e2e.yml`
 * does. Repeated rather than imported across a workspace boundary.
 */
export function skipUnlessIntegrationEnv(suiteName: string, ...required: string[]): boolean {
  const missing = required.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length === 0) return false;

  const flag = (process.env['REQUIRE_INTEGRATION_ENV'] ?? '').trim().toLowerCase();
  if (flag !== '' && flag !== '0' && flag !== 'false') {
    throw new Error(
      `${suiteName} is mandatory because REQUIRE_INTEGRATION_ENV is set, but ` +
        `${missing.join(', ')} is missing or empty.`,
    );
  }
  return true;
}

/**
 * A database of its own for one suite, migrated by `DATABASE_URL`'s user —
 * the superuser, in compose and in CI — with `ledger_writer` given a login for
 * the run. Dropped afterwards. `DATABASE_URL`'s own database is never touched,
 * so nothing here races memory-core's suites.
 */
export interface LedgerDatabase {
  readonly name: string;
  /** The superuser, in the suite's database: the tables' owner. */
  readonly owner: pg.Pool;
  /** `ledger_writer`: SELECT and INSERT, nothing else. */
  readonly writer: pg.Pool;
  readonly ownerUrl: string;
  readonly writerUrl: string;
  writerPool(): pg.Pool;
  drop(): Promise<void>;
}

export async function createLedgerDatabase(prefix: string): Promise<LedgerDatabase> {
  const adminUrl = process.env['DATABASE_URL']!;
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');

  const admin = quiet(new pg.Pool({ connectionString: adminUrl }));
  await admin.query(`CREATE DATABASE ${name}`);

  const ownerUrl = withDatabase(adminUrl, name);
  const owner = quiet(new pg.Pool({ connectionString: ownerUrl }));
  await runLedgerMigrations(owner, { writerPassword: password });

  const writerUrl = withUser(ownerUrl, 'ledger_writer', password);
  const pools: pg.Pool[] = [];
  const writerPool = () => {
    const pool = quiet(new pg.Pool({ connectionString: writerUrl }));
    pools.push(pool);
    return pool;
  };
  const writer = writerPool();

  return {
    name,
    owner,
    writer,
    ownerUrl,
    writerUrl,
    writerPool,
    drop: async () => {
      await Promise.all(pools.map((pool) => pool.end()));
      await owner.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/**
 * `pool.end()` can resolve while a client is still closing, and `DROP DATABASE
 * … WITH (FORCE)` then terminates it. Without a listener that termination is
 * an uncaught `error` event, which fails the run after every test passed.
 */
function quiet(pool: pg.Pool): pg.Pool {
  pool.on('error', () => undefined);
  return pool;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export function withUser(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}
