/**
 * The demo signer (P3-E): `yarn workspace @repo/agent-service review:sign`.
 *
 *   review:sign keygen --key-id <id> --reviewer <id> --credential <type>
 *                      --jurisdiction <code> [--dir <dir>]
 *     Writes <dir>/<id>.pem (the private key, mode 0600; <dir> defaults to
 *     .review-keys, which is gitignored) and prints the registry entry for its
 *     public half, to add to the file REVIEWER_REGISTRY names.
 *
 *   review:sign sign --key <pem> --key-id <id> --case <case.json>
 *                    --determination <determination.json>
 *     Reads a `GET /review/cases/:caseId` response and a determination, and
 *     prints the body to POST to `/review/cases/:caseId/determination`.
 *
 * It lives here rather than in `scripts/` because it must sign exactly the
 * bytes the service verifies, and those come from `signature.ts`; a root
 * script may import only root devDependencies (`.context/conventions.md`).
 * Every value passed to it in this repository is synthetic.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { generateReviewerKey, signDetermination } from './signer.js';

const CaseViewSigningSchema = z.object({
  signing: z.object({
    runId: z.string().uuid(),
    recommendationSeq: z.number().int().nullable(),
  }),
});

function required(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (value === undefined || value === '') throw new Error(`--${name} is required`);
  return value;
}

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      'key-id': { type: 'string' },
      reviewer: { type: 'string' },
      credential: { type: 'string' },
      jurisdiction: { type: 'string' },
      dir: { type: 'string' },
      key: { type: 'string' },
      case: { type: 'string' },
      determination: { type: 'string' },
    },
  });

  if (command === 'keygen') {
    const reviewerKeyId = required(values, 'key-id');
    const { privateKeyPem, entry } = generateReviewerKey({
      reviewerKeyId,
      reviewerId: required(values, 'reviewer'),
      credential: {
        type: required(values, 'credential'),
        jurisdiction: required(values, 'jurisdiction'),
      },
    });
    const dir = values.dir ?? '.review-keys';
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${reviewerKeyId}.pem`);
    writeFileSync(path, privateKeyPem, { mode: 0o600 });
    chmodSync(path, 0o600);
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    process.stderr.write(`private key written to ${path}; the entry above is its public half\n`);
    return;
  }

  if (command === 'sign') {
    const view = CaseViewSigningSchema.parse(
      JSON.parse(readFileSync(required(values, 'case'), 'utf8')),
    );
    const determination = z
      .record(z.unknown())
      .parse(JSON.parse(readFileSync(required(values, 'determination'), 'utf8')));
    const body = signDetermination({
      privateKeyPem: readFileSync(required(values, 'key'), 'utf8'),
      reviewerKeyId: required(values, 'key-id'),
      signing: view.signing,
      determination,
    });
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }

  throw new Error('usage: review:sign keygen ... | review:sign sign ... (see sign-cli.ts)');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
