import { readFile } from 'node:fs/promises';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PgRunRecordRepository, createReadOnlyPool } from '@repo/memory-core';
import {
  Ledger,
  PgLedgerStore,
  createLedgerPool,
  fromJsonl,
  type LedgerRows,
} from '@repo/decision-ledger';
import { loadEnvFile } from '../load-env.js';
import { renderLedgerReport, verifyLedger, type LedgerVerifyReport } from './verify-ledger.js';

/**
 * `node dist/ledger/verify.js [--chain-only] [--export <file>] [--json]` —
 * the auditor's command over the ledger (P3-C). `yarn ledger:verify` at the
 * root builds first.
 *
 * Reads `LEDGER_DATABASE_URL` (or an export with `--export`, which needs
 * `--chain-only`), `DATABASE_URL` for the run records and checkpoints unless
 * `--chain-only`, and `LEDGER_TSA_CA` for the anchors. Every session it opens
 * is read-only, so verifying writes nothing.
 *
 * Exit 0 verified; 1 the first failure, named by seq and run; 2 it could not
 * check.
 */

const USAGE = 'usage: node dist/ledger/verify.js [--chain-only] [--export <file>] [--json]';

interface Args {
  readonly chainOnly: boolean;
  readonly json: boolean;
  readonly exportFile?: string;
}

function parseArgs(argv: readonly string[]): Args | null {
  let chainOnly = false;
  let json = false;
  let exportFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--chain-only') chainOnly = true;
    else if (arg === '--json') json = true;
    else if (arg === '--export' && argv[index + 1] !== undefined) exportFile = argv[(index += 1)];
    else return null;
  }
  if (exportFile !== undefined && !chainOnly) return null;
  return { chainOnly, json, ...(exportFile === undefined ? {} : { exportFile }) };
}

function unverifiable(reason: string): never {
  throw new Error(reason);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    process.stderr.write(`${USAGE}\n--export reads a JSONL file and needs --chain-only.\n`);
    return 2;
  }
  loadEnvFile();

  const caFile = nonEmpty(process.env['LEDGER_TSA_CA']);
  const cleanups: (() => Promise<void>)[] = [];
  try {
    let rows: LedgerRows;
    if (args.exportFile !== undefined) {
      rows = fromJsonl(await readFile(args.exportFile, 'utf8'));
    } else {
      const ledgerUrl =
        nonEmpty(process.env['LEDGER_DATABASE_URL']) ??
        unverifiable('ledger:verify needs LEDGER_DATABASE_URL, or --chain-only --export <file>.');
      const pool = createLedgerPool(ledgerUrl, { readOnly: true });
      cleanups.push(() => pool.end());
      rows = await new Ledger(new PgLedgerStore(pool)).readRows();
    }

    let runs: Parameters<typeof verifyLedger>[0]['runs'];
    if (!args.chainOnly) {
      const databaseUrl =
        nonEmpty(process.env['DATABASE_URL']) ??
        unverifiable(
          'ledger:verify needs DATABASE_URL to re-derive run digests; pass --chain-only to check the chain alone.',
        );
      const pool = createReadOnlyPool(databaseUrl);
      cleanups.push(() => pool.end());
      // The saver reads its own tables; `setup()` is never called, it would write.
      runs = { records: new PgRunRecordRepository(pool), checkpointer: new PostgresSaver(pool) };
    }

    const report: LedgerVerifyReport = await verifyLedger({
      rows,
      ...(caFile === undefined ? {} : { caFile }),
      ...(runs === undefined ? {} : { runs }),
    });
    process.stdout.write(
      args.json ? `${JSON.stringify(report, null, 2)}\n` : renderLedgerReport(report),
    );
    return report.exitCode;
  } catch (error) {
    process.stderr.write(
      `ledger:verify could not run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  } finally {
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ledger:verify failed: ${String(error)}\n`);
    process.exitCode = 2;
  },
);
