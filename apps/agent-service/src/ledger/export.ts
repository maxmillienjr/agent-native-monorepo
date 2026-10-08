import { Ledger, PgLedgerStore, createLedgerPool, toJsonl } from '@repo/decision-ledger';
import { loadEnvFile } from '../load-env.js';

/**
 * `node dist/ledger/export.js [--no-payloads]` — writes the ledger to stdout
 * as JSON Lines (P3-C), which `ledger:verify --chain-only --export <file>`
 * checks with no database.
 *
 * `--no-payloads` leaves every payload out. The chain, the head and the
 * anchors still verify, and disclose nothing, because the commitments are
 * salted: that export can go to anyone.
 */

async function main(argv: readonly string[]): Promise<number> {
  const unknown = argv.filter((arg) => arg !== '--no-payloads');
  if (unknown.length > 0) {
    process.stderr.write('usage: node dist/ledger/export.js [--no-payloads]\n');
    return 2;
  }
  loadEnvFile();
  const ledgerUrl = process.env['LEDGER_DATABASE_URL'];
  if (!ledgerUrl) {
    process.stderr.write('ledger:export needs LEDGER_DATABASE_URL.\n');
    return 2;
  }

  const pool = createLedgerPool(ledgerUrl, { readOnly: true });
  try {
    const rows = await new Ledger(new PgLedgerStore(pool)).readRows();
    process.stdout.write(toJsonl(rows, { payloads: !argv.includes('--no-payloads') }));
    return 0;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ledger:export failed: ${String(error)}\n`);
    process.exitCode = 2;
  },
);
