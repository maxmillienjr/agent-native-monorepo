import { Ledger, PgLedgerStore, anchorHead, createLedgerPool } from '@repo/decision-ledger';
import { loadEnvFile } from '../load-env.js';

/**
 * `node dist/ledger/anchor.js` — time-stamps the ledger's head with an
 * RFC 3161 authority and stores the token (P3-C). `yarn ledger:anchor` at the
 * root builds first.
 *
 * Reads `LEDGER_DATABASE_URL`, `LEDGER_TSA_URL`, and `LEDGER_TSA_CA` when set,
 * in which case the token is verified before it is stored. The authority sees
 * the head's hash and nothing else.
 *
 * Running this on a schedule, and archiving the tokens somewhere the database
 * administrator does not control, is an operator's job: an anchor only limits
 * a rewrite if someone other than the DBA holds it.
 *
 * Exit 0 anchored, already anchored, or nothing to anchor; 1 the authority
 * refused or the token did not verify; 2 not configured.
 */

async function main(): Promise<number> {
  loadEnvFile();
  const ledgerUrl = process.env['LEDGER_DATABASE_URL'];
  const tsaUrl = process.env['LEDGER_TSA_URL'];
  const caFile = process.env['LEDGER_TSA_CA'];
  if (!ledgerUrl || !tsaUrl) {
    process.stderr.write('ledger:anchor needs LEDGER_DATABASE_URL and LEDGER_TSA_URL.\n');
    return 2;
  }

  const pool = createLedgerPool(ledgerUrl);
  try {
    const result = await anchorHead(new Ledger(new PgLedgerStore(pool)), {
      tsaUrl,
      ...(caFile ? { caFile } : {}),
    });
    switch (result.kind) {
      case 'empty':
        process.stdout.write('ledger:anchor — the ledger is empty; nothing to anchor.\n');
        break;
      case 'already-anchored':
        process.stdout.write(
          `ledger:anchor — the head, seq ${result.anchor.seq}, is already anchored at ${result.anchor.anchoredAt}.\n`,
        );
        break;
      case 'anchored':
        process.stdout.write(
          `ledger:anchor — anchored seq ${result.entry.seq} (${result.entry.entryHash}) ` +
            `with ${result.anchor.tsaUrl} at ${result.anchor.anchoredAt}` +
            `${caFile ? '; the token verifies against LEDGER_TSA_CA' : '; not verified, LEDGER_TSA_CA is unset'}.\n`,
        );
        break;
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `ledger:anchor failed: ${error instanceof Error ? error.message : String(error)}\n`,
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
    process.stderr.write(`ledger:anchor failed: ${String(error)}\n`);
    process.exitCode = 2;
  },
);
