/**
 * scripts/lint-data.mjs over fixtures, one per rule (P3-D, CTL-DATA-01).
 *
 * Each violating value is all zeros or a placeholder, which has the shape of
 * a code without being one anyone could look up, and each fixture is written
 * so that exactly one rule fires. The fixtures are not excluded from the
 * tree-wide scan; scripts/lint-data.allow.json names each one with a reason,
 * and an entry that stops matching fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintData, readAllowlist } from './lint-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => `scripts/__fixtures__/data/${name}`;

const cases = [
  ['d1-system-not-listed.json', 'D1'],
  ['d2-hcpcs-not-level-ii.json', 'D2'],
  ['d3-icd10cm-shape.json', 'D3'],
  ['d4-code-shaped-value.json', 'D4'],
  ['d5-name-without-digits.json', 'D5'],
  ['t1-anchored-code.txt', 'T1'],
  ['t2-ssn-shape.txt', 'T2'],
];

for (const [name, rule] of cases) {
  test(`${name} fails with ${rule} and no other rule`, () => {
    const problems = lintData([fixture(name)], []);
    assert.deepEqual(
      problems.map((problem) => problem.rule),
      [rule],
      problems.map((problem) => problem.message).join('\n'),
    );
  });
}

test('a clean fixture passes', () => {
  assert.deepEqual(lintData([fixture('clean.json')], []), []);
});

test('the committed allowlist covers exactly the fixtures, one entry each', () => {
  const allowlist = readAllowlist(join(here, 'lint-data.allow.json'));
  assert.deepEqual(
    allowlist.map((entry) => entry.file).sort(),
    cases.map(([name]) => fixture(name)).sort(),
  );
  assert.deepEqual(
    lintData(
      cases.map(([name]) => fixture(name)),
      allowlist,
    ),
    [],
  );
});

test('an allowlist entry whose token is absent from its file fails', () => {
  const problems = lintData(
    [fixture('clean.json')],
    [
      {
        file: fixture('clean.json'),
        token: 'a-token-the-file-does-not-hold',
        reason: 'stale on purpose',
      },
    ],
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, 'ALLOW');
  assert.match(problems[0].message, /no longer contains it/);
});

test('the command exits 1 and names the rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-data-'));
  const empty = join(dir, 'allow.json');
  writeFileSync(empty, '[]');
  const run = spawnSync(
    process.execPath,
    [
      join(here, 'lint-data.mjs'),
      '--allow',
      empty,
      '--files',
      join(here, '__fixtures__', 'data', 't2-ssn-shape.txt'),
    ],
    { encoding: 'utf-8' },
  );
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /\[T2\]/);
});
