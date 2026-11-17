/**
 * scripts/prd-site.mjs builds "Specced vs shipped" from docs/prd. These tests fail the docs
 * gate when the site would be wrong: a PRD missing a field the site reads, a dependency id
 * that names no PRD, or a link the site makes that does not resolve locally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, readPrdFiles } from './prd-site.mjs';

const prd = (id, fields = {}, body = '') => {
  const fm = {
    id,
    title: `Title of ${id}`,
    tier: 1,
    status: 'shipped',
    size: 'S',
    depends_on: '[]',
    blocks: '[]',
    issue: 'null',
    superseded_by: 'null',
    ...fields,
  };
  const head = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    file: `${id}-x.md`,
    text: `---\n${head}\n---\n\n# ${id} · Title\n\n## Problem\n\nIt is broken.\n${body}`,
  };
};

test('the repository PRDs build with no problems', () => {
  const { problems, prds, pages } = buildSite(readPrdFiles());
  assert.deepEqual(problems, []);
  assert.equal(pages.size, prds.length + 1);
});

test('two builds of the same files are byte-identical', () => {
  const a = buildSite(readPrdFiles(), { commit: 'abc1234' }).pages;
  const b = buildSite(readPrdFiles(), { commit: 'abc1234' }).pages;
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test('a PRD missing a field the site reads fails', () => {
  const { problems } = buildSite([prd('P1-A', { size: undefined })]);
  assert.ok(
    problems.some((p) => /P1-A-x\.md: frontmatter is missing `size`/.test(p)),
    problems.join('\n'),
  );
});

test('a depends_on or blocks id that names no PRD fails', () => {
  const { problems } = buildSite([
    prd('P1-A', { depends_on: '[P9-Z]' }),
    prd('P1-B', { blocks: '[P8-Y]' }),
  ]);
  assert.ok(
    problems.some((p) => /depends_on names P9-Z/.test(p)),
    problems.join('\n'),
  );
  assert.ok(
    problems.some((p) => /blocks names P8-Y/.test(p)),
    problems.join('\n'),
  );
});

test('a link to a repo path that does not exist fails', () => {
  const { problems } = buildSite([
    prd('P1-A', {}, '\nSee [gone](../../packages/no-such-thing.ts).\n'),
  ]);
  assert.ok(
    problems.some((p) => /packages\/no-such-thing\.ts, which is not in the repo/.test(p)),
    problems.join('\n'),
  );
});

test('a link to another PRD becomes its page, and one to a missing PRD file fails', () => {
  const ok = buildSite([prd('P1-A', {}, '\nSee [P1-B](P1-B-x.md).\n'), prd('P1-B')]);
  assert.deepEqual(ok.problems, []);
  assert.match(ok.pages.get('P1-A.html'), /href="P1-B\.html"/);
  const bad = buildSite([prd('P1-A', {}, '\nSee [P1-C](P1-C-x.md).\n')]);
  assert.ok(
    bad.problems.some((p) => /P1-C-x\.md, which is not in the repo/.test(p)),
    bad.problems.join('\n'),
  );
});

test('a PRD with no divergence section says so from its status', () => {
  const { pages } = buildSite([prd('P1-A', { status: 'in-progress' }), prd('P1-B')]);
  assert.match(pages.get('P1-A.html'), /Not shipped yet: the PRD's status is "in progress"/);
  assert.match(pages.get('P1-B.html'), /Shipped, with no section on where the build diverged/);
});

test('a section of another name that records what shipped is shown and counted apart', () => {
  const { pages } = buildSite([
    prd('P1-A', {}, '\n## What shipped\n\nIt shipped as designed.\n'),
    prd('P1-B', {}, '\n## What shipped, and where it diverged\n\nIt did not.\n'),
  ]);
  assert.match(pages.get('P1-A.html'), /under this heading instead/);
  assert.match(pages.get('P1-A.html'), /It shipped as designed\./);
  assert.match(pages.get('index.html'), /1 has a section on what shipped and where it diverged/);
  assert.match(pages.get('index.html'), /1 more records what the build did/);
});

test('a code span closes on a backtick run of its own length', () => {
  const { pages } = buildSite([prd('P1-A', {}, '\nWraps it in a ` ```json ` fence.\n')]);
  assert.match(pages.get('P1-A.html'), /in a <code>```json<\/code> fence/);
});
