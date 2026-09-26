/**
 * docs/STATUS.md cites its evidence by name, and scripts/lint-docs.mjs resolves each name.
 * This runs that check over a fixture matrix whose rows no longer resolve, and expects each
 * of them to fail the lint by name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '__fixtures__', 'status', 'STATUS.md');

test('a STATUS.md row whose anchor no longer resolves fails the docs lint', () => {
  const run = spawnSync(process.execPath, [join(here, 'lint-docs.mjs'), '--status', fixture], {
    encoding: 'utf-8',
  });
  assert.notEqual(run.status, 0, `expected a failure, got:\n${run.stdout}`);
  const problems = run.stderr.split('\n').filter((line) => line.trim().startsWith('✗'));
  const expected = [
    /guard\.ts#guardRenamed` does not resolve: `guardRenamed` is declared on 0 lines/,
    /guard\.test\.ts#holds the line firmly` does not resolve: test title 'holds the line firmly' matches 0 calls/,
    /guard\.test\.ts#rejects a value past the limit` does not resolve: .* is `it\.skip`/,
    /rule\.md#The old rule` does not resolve: .* has no heading `The old rule`/,
    /fixture\.yml#audit` does not resolve: .* has no job `audit`/,
    /package\.json#scripts\.test:service` does not resolve: .* has no key `scripts\.test:service`/,
    /cites `controls\/repo\/packages\/demo\/src\/guard\.ts:4` — line anchors rot/,
    /cites `controls\/repo\/docs\/gone\.md`, which matches 0 tracked files, not 1/,
  ];
  assert.equal(problems.length, expected.length, problems.join('\n'));
  for (const pattern of expected) {
    assert.ok(
      problems.some((line) => pattern.test(line)),
      `no problem matches ${pattern}:\n${problems.join('\n')}`,
    );
  }
});
