/**
 * The ruleset's required checks resolve to exactly one workflow job each (P1-D). Run over
 * the repository's own ruleset and workflows, and over each of them edited the way a
 * change would break the link: a renamed job, a Node bump, a second job with the name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuleset, workflowCheckNames } from './lib/ruleset.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ruleset = JSON.parse(readFileSync(join(root, '.github', 'rulesets', 'main.json'), 'utf-8'));
const workflowDir = join(root, '.github', 'workflows');
const workflows = readdirSync(workflowDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => ({ file, text: readFileSync(join(workflowDir, file), 'utf-8') }));

/** The workflows with one file's text passed through `edit`. */
const edited = (file, edit) =>
  workflows.map((w) => (w.file === file ? { file, text: edit(w.text) } : w));

test('every context in the committed ruleset is reported by exactly one job', () => {
  assert.deepEqual(checkRuleset(ruleset, workflows), []);
});

test('a job name is its matrix values appended in key order', () => {
  const { names } = workflowCheckNames(
    'ci.yml',
    readFileSync(join(workflowDir, 'ci.yml'), 'utf-8'),
  );
  assert.deepEqual(names, [
    'ci (24.x)',
    'images (agent-service)',
    'images (gateway)',
    'images (console)',
  ]);
});

test('renaming eval-replay leaves a required check nothing reports', () => {
  const problems = checkRuleset(
    ruleset,
    edited('agent-eval.yml', (t) => t.replace('name: eval-replay\n', 'name: replay\n')),
  );
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /requires the check `eval-replay`, which no workflow job reports/);
});

test('a Node bump in the matrix renames the ci check', () => {
  const problems = checkRuleset(
    ruleset,
    edited('ci.yml', (t) => t.replace("node: ['24.x']", "node: ['25.x']")),
  );
  assert.match(problems.join('\n'), /requires the check `ci \(24\.x\)`, which no workflow job/);
});

test('a second job with a required name is ambiguous', () => {
  const problems = checkRuleset(
    ruleset,
    edited('agent-eval.yml', (t) => t.replace('name: eval-live-gate\n', 'name: eval-replay\n')),
  );
  assert.match(problems.join('\n'), /`eval-replay`, which 2 workflow jobs report/);
});

test('a matrix or a name it cannot expand is refused, not guessed', () => {
  const text = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        include: [{ os: linux }]',
    '  b:',
    '    name: build ${{ matrix.os }}',
  ].join('\n');
  const { problems } = workflowCheckNames('x.yml', text);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /job `a` has a matrix this check cannot expand/);
  assert.match(problems[1], /job `b` has an expression in its name/);
});

test('a ruleset that requires nothing gates nothing', () => {
  assert.match(checkRuleset({ rules: [] }, workflows)[0], /requires no status check/);
});
