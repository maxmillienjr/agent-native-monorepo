/**
 * One fixture per failure mode of scripts/lint-controls.mjs. Each fixture beside `repo/` is
 * the baseline catalogue with exactly one thing broken, so each run must fail with exactly
 * one problem, and that problem must name the control and the cause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './lib/anchors.mjs';

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

// (b) Evidence that no longer exists: an anchor that does not resolve.
const staleEvidence = [
  [
    'symbol-file-untracked',
    'CTL-TEST-01',
    /packages\/demo\/src\/missing\.ts` is not a tracked file/,
  ],
  ['symbol-not-declared', 'CTL-TEST-01', /`guardRenamed` is declared on 0 lines/],
  ['test-title-missing', 'CTL-TEST-01', /test title 'holds the line firmly' matches 0 calls/],
  ['test-title-skipped', 'CTL-TEST-01', /is `it\.skip`, which does not run/],
  ['ci-job-missing', 'CTL-TEST-01', /fixture\.yml has no job `audit`/],
  ['ci-run-missing', 'CTL-TEST-01', /has no step whose run contains `yarn audit-licenses`/],
];

// (c) PRDs, the catalogue and the matrix disagree.
const disagreement = [
  [
    'prd-lists-unknown-control',
    'CTL-PLAN-01',
    /P8-B-next\.md: lists CTL-PLAN-01 in controls, which the catalogue does not have/,
  ],
  ['planned-owner-shipped', 'CTL-PLAN-02', /is planned under P8-A, which is shipped/],
  ['owner-file-does-not-list', 'CTL-PLAN-02', /P8-B-next\.md does not list it in controls/],
  [
    'matrix-not-regenerated',
    'CONTROLS.md',
    /governance\/CONTROLS\.md is stale — run yarn controls:matrix/,
  ],
];

for (const [name, control, cause] of [...noBacking, ...staleEvidence, ...disagreement]) {
  test(`fails on ${name}, naming ${control}`, () => {
    const run = lint(['--root', fixtureRepo, '--catalogue', join(fixtures, `${name}.yaml`)]);
    assert.notEqual(run.status, 0, `expected a failure, got:\n${run.stdout}`);
    const found = problems(run.stderr);
    assert.equal(found.length, 1, `expected exactly one problem, got:\n${found.join('\n')}`);
    assert.ok(found[0].includes(control), `the problem does not name ${control}: ${found[0]}`);
    assert.match(found[0], cause);
  });
}

test('fails when CONTROLS.md is edited by hand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'controls-matrix-'));
  try {
    const edited = join(dir, 'CONTROLS.md');
    const original = readFileSync(join(fixtureRepo, 'governance', 'CONTROLS.md'), 'utf-8');
    writeFileSync(edited, original.replace('The guard holds', 'The guard always holds'));
    const run = lint(['--root', fixtureRepo, '--matrix', edited]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /CONTROLS\.md is stale — run yarn controls:matrix/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The property the STATUS.md line check never had: an anchor keeps resolving when the lines
 * above it move, and stops resolving when the thing it names is renamed. Runs on a copy of
 * the fixture tree in its own git repository, because resolution reads `git ls-files`.
 */
test('an anchor survives twenty inserted lines and fails on a rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'controls-anchor-'));
  try {
    cpSync(fixtureRepo, dir, { recursive: true });
    // Without gitEnv(), a GIT_DIR inherited from a hook or `rebase --exec` points these two
    // calls at the enclosing repository: `init` rewrites its core.bare and `add` stages the
    // copy into its index.
    execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
    const source = join(dir, 'packages', 'demo', 'src', 'guard.ts');
    const original = readFileSync(source, 'utf-8');

    writeFileSync(source, '// padding\n'.repeat(20) + original);
    const moved = lint(['--root', dir]);
    assert.equal(moved.status, 0, moved.stderr);

    writeFileSync(source, original.replace('function guard(', 'function guarded('));
    const renamed = lint(['--root', dir]);
    assert.notEqual(renamed.status, 0);
    const found = problems(renamed.stderr);
    assert.equal(found.length, 1, found.join('\n'));
    assert.match(
      found[0],
      /CTL-TEST-01: evidence\[0\] \(symbol\) does not resolve: `guard` is declared on 0 lines/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
