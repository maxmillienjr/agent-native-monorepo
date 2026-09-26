/**
 * One fixture per failure mode of scripts/lint-controls.mjs. Each fixture beside `repo/` is
 * the baseline catalogue with exactly one thing broken, so each run must fail with exactly
 * one problem, and that problem must name the control and the cause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'lint-controls.mjs');
const fixtures = join(here, '__fixtures__', 'controls');
const fixtureRepo = join(fixtures, 'repo');

function lint(args) {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function problems(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.trim().startsWith('✗'))
    .map((line) => line.trim());
}

test('the baseline fixture passes, and its matrix is current', () => {
  const run = lint(['--root', fixtureRepo]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /4 control\(s\).*CONTROLS\.md is current/);
});

// (a) A control with no backing: it fails the schema or the status rules.
const noBacking = [
  [
    'implemented-without-executable-anchor',
    'CTL-TEST-01',
    /is implemented with no test or ci anchor/,
  ],
  ['planned-without-owner', 'CTL-PLAN-01', /is planned with no owner/],
  [
    'not-applicable-without-rationale',
    'CTL-NA-01',
    /not-applicable without a rationale of at least 40 characters/,
  ],
  ['ref-not-in-registry', 'CTL-TEST-01', /maps to `D-9`, which is not a clause of demo-fw/],
  ['line-anchor', 'CTL-TEST-01', /evidence\[0\]\.file: line anchors rot/],
];

for (const [name, control, cause] of noBacking) {
  test(`fails on ${name}, naming ${control}`, () => {
    const run = lint(['--root', fixtureRepo, '--catalogue', join(fixtures, `${name}.yaml`)]);
    assert.notEqual(run.status, 0, `expected a failure, got:\n${run.stdout}`);
    const found = problems(run.stderr);
    assert.equal(found.length, 1, `expected exactly one problem, got:\n${found.join('\n')}`);
    assert.ok(found[0].includes(control), `the problem does not name ${control}: ${found[0]}`);
    assert.match(found[0], cause);
  });
}
