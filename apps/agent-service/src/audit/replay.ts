import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PgRunRecordRepository, createReadOnlyPool } from '@repo/memory-core';
import { loadEnvFile } from '../load-env.js';
import { codeIdentity } from './code-identity.js';
import { replayRun } from './replay-run.js';
import { render } from './replay-report.js';

/**
 * `node dist/audit/replay.js <runId> [--read-only] [--json]` — the operator
 * command over a run record (P3-B). `yarn audit:replay <runId>` at the root
 * builds first.
 *
 * Exit 0: every checkpoint matched, the counts matched, every recorded
 * decision was consumed. Exit 1: the replay diverged, and the report names the
 * first divergent step. Exit 2: the run cannot be replayed here — no record,
 * no commit, another commit, or no database — and nothing was executed.
 *
 * It reads through a read-only pool and constructs no Neo4j driver and no
 * model client, so it makes no write and no model request whatever the
 * record holds. It needs `DATABASE_URL` and nothing else.
 */

const USAGE = 'usage: node dist/audit/replay.js <runId> [--read-only] [--json]';

async function main(argv: readonly string[]): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const [runId, ...extra] = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = [...flags].filter((flag) => flag !== '--read-only' && flag !== '--json');

  if (runId === undefined || extra.length > 0 || unknown.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  loadEnvFile();
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    process.stderr.write('audit:replay needs DATABASE_URL: the run record lives in Postgres.\n');
    return 2;
  }

  const pool = createReadOnlyPool(databaseUrl);
  try {
    const report = await replayRun({
      runId,
      records: new PgRunRecordRepository(pool),
      // The saver reads its own tables through the same read-only pool.
      // `setup()` is never called: it would write.
      checkpointer: new PostgresSaver(pool),
      buildSha: codeIdentity().sha,
      readOnly: flags.has('--read-only'),
    });

    process.stdout.write(
      flags.has('--json') ? `${JSON.stringify(report, null, 2)}\n` : render(report),
    );
    return report.exitCode;
  } catch (error) {
    process.stderr.write(
      `audit:replay could not run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`audit:replay failed: ${String(error)}\n`);
    process.exitCode = 2;
  },
);
