import { createLedgerPool, runLedgerMigrations } from '@repo/decision-ledger';
import { loadEnvFile } from '../load-env.js';

/**
 * `node dist/ledger/migrate.js` — applies the ledger's migrations and
 * `roles.sql` as the tables' owner (P3-C). `yarn ledger:migrate` at the root
 * builds first.
 *
 * Reads `LEDGER_OWNER_URL`, a role that may create tables and roles — never
 * the one the service runs as, which must not be able to. With
 * `LEDGER_WRITER_PASSWORD`, `ledger_writer` is given a login with that
 * password: the local path. A deployment issues that credential from its
 * secret store.
 *
 * The service does not migrate the ledger at boot, unlike memory, because the
 * role it connects as cannot.
 */

async function main(): Promise<number> {
  loadEnvFile();
  const ownerUrl = process.env['LEDGER_OWNER_URL'];
  if (!ownerUrl) {
    process.stderr.write(
      'ledger:migrate needs LEDGER_OWNER_URL: the role that owns the ledger tables.\n',
    );
    return 2;
  }
  const password = process.env['LEDGER_WRITER_PASSWORD'];

  const pool = createLedgerPool(ownerUrl);
  try {
    await runLedgerMigrations(pool, password ? { writerPassword: password } : {});
    process.stdout.write(
      `ledger:migrate — migrated; ledger_writer holds SELECT and INSERT` +
        `${password ? ' and can log in' : ''}.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `ledger:migrate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ledger:migrate failed: ${String(error)}\n`);
    process.exitCode = 2;
  },
);
