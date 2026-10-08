#!/usr/bin/env node
/**
 * Structural lint for docs/prd and docs/adr.
 *
 * Context packs drift silently — this repo is the proof, having documented a TTL,
 * an HNSW index, and testcontainers that were never implemented. Prose can't be
 * checked mechanically, but structure can, and structure is where drift shows up
 * first: an id that resolves nowhere, a dependency that isn't mutual, a status in
 * the index that no longer matches the file.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { frontmatter, prdIndexRows } from './lib/frontmatter.mjs';
import { createRepo, checkInlineAnchors } from './lib/anchors.mjs';
import { lintControls, defaultPaths } from './lint-controls.mjs';
import { checkRuleset } from './lib/ruleset.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const prdDir = join(root, 'docs', 'prd');
const adrDir = join(root, 'docs', 'adr');

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

const STATUSES = ['draft', 'accepted', 'in-progress', 'shipped', 'superseded'];
const SIZES = ['S', 'M', 'L'];
const REQUIRED = [
  'id',
  'title',
  'tier',
  'status',
  'size',
  'depends_on',
  'blocks',
  'issue',
  'superseded_by',
];

// --- PRD index is the registry of known ids -------------------------------
const prdIndexPath = join(prdDir, 'README.md');
if (!existsSync(prdIndexPath)) {
  fail('docs/prd/README.md', 'missing — the index is the source of truth for the backlog');
}
const prdIndex = prdIndexRows(readFileSync(prdIndexPath, 'utf-8'));
if (prdIndex.size === 0) fail('docs/prd/README.md', 'no PRD rows parsed from the index tables');

// --- Each PRD file -------------------------------------------------------
const files = readdirSync(prdDir).filter(
  (f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md',
);
const byId = new Map();

for (const file of files) {
  const where = `docs/prd/${file}`;
  const body = readFileSync(join(prdDir, file), 'utf-8');
  const fm = frontmatter(body);
  if (!fm) {
    fail(where, 'no YAML frontmatter block');
    continue;
  }
  for (const key of REQUIRED) {
    if (!(key in fm)) fail(where, `frontmatter is missing \`${key}\``);
  }
  if (fm.status && !STATUSES.includes(fm.status))
    fail(where, `status \`${fm.status}\` is not one of ${STATUSES.join(', ')}`);
  if (fm.size && !SIZES.includes(fm.size))
    fail(where, `size \`${fm.size}\` is not one of ${SIZES.join(', ')}`);
  if (fm.id && !file.startsWith(`${fm.id}-`))
    fail(where, `filename does not start with its id \`${fm.id}\``);
  if (fm.id && !prdIndex.has(fm.id)) fail(where, `id \`${fm.id}\` is not listed in the index`);
  if (fm.id && prdIndex.has(fm.id)) {
    const row = prdIndex.get(fm.id);
    if (row.status !== fm.status)
      fail(where, `status \`${fm.status}\` disagrees with the index, which says \`${row.status}\``);
    if (row.size !== fm.size)
      fail(where, `size \`${fm.size}\` disagrees with the index, which says \`${row.size}\``);
  }
  if (fm.status === 'in-progress' && !fm.issue)
    fail(where, 'status is `in-progress` but no issue is recorded');
  if (fm.status === 'superseded' && !fm.superseded_by)
    fail(where, 'status is `superseded` but `superseded_by` is empty');

  // A shipped PRD may still carry unmet criteria — but each one must name the PRD that
  // now owns it. The naive rule (shipped implies zero unchecked boxes) is worse than
  // useless: it pressures the author to tick a box and append a caveat, which is exactly
  // how `shipped` stops meaning anything.
  if (fm.status === 'shipped') {
    const section = /## Acceptance criteria\n([\s\S]*?)(?=\n## )/.exec(body);
    if (section) {
      for (const item of section[1].split(/\n(?=- \[)/)) {
        if (!item.trim().startsWith('- [ ]')) continue;
        if (!/\bP\d-[A-Z]\b/.test(item))
          fail(
            where,
            'is shipped with an unmet criterion that names no owning PRD: ' +
              `"${item.replace(/\s+/g, ' ').slice(6, 76).trim()}…"`,
          );
      }
    }
  }
  if (fm.id) byId.set(fm.id, { fm, where });
}

// --- Referential integrity ------------------------------------------------
for (const [id, { fm, where }] of byId) {
  for (const key of ['depends_on', 'blocks']) {
    for (const ref of fm[key] ?? []) {
      if (!prdIndex.has(ref))
        fail(where, `${key} references \`${ref}\`, which is not in the index`);
    }
  }
  // Symmetry, checkable only where both files exist.
  for (const ref of fm.blocks ?? []) {
    const other = byId.get(ref);
    if (other && !(other.fm.depends_on ?? []).includes(id))
      fail(where, `blocks \`${ref}\`, but ${ref} does not list \`${id}\` in depends_on`);
  }
  for (const ref of fm.depends_on ?? []) {
    const other = byId.get(ref);
    if (other && !(other.fm.blocks ?? []).includes(id))
      fail(where, `depends_on \`${ref}\`, but ${ref} does not list \`${id}\` in blocks`);
  }
  if (fm.superseded_by && !prdIndex.has(fm.superseded_by))
    fail(where, `superseded_by references \`${fm.superseded_by}\`, which is not in the index`);
}

// --- ADRs -----------------------------------------------------------------
const adrIndexPath = join(adrDir, 'README.md');
if (existsSync(adrIndexPath)) {
  const indexed = new Set();
  for (const line of readFileSync(adrIndexPath, 'utf-8').split('\n')) {
    const row = /^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|/.exec(line);
    if (!row) continue;
    indexed.add(row[2]);
    if (!existsSync(join(adrDir, row[2])))
      fail('docs/adr/README.md', `index lists \`${row[2]}\`, which does not exist`);
  }
  for (const file of readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f))) {
    if (!indexed.has(file)) fail(`docs/adr/${file}`, 'exists but is not listed in the ADR index');
    const text = readFileSync(join(adrDir, file), 'utf-8');
    if (!/^\*\*Status:\*\*\s*(\S+)/m.test(text))
      fail(`docs/adr/${file}`, 'has no **Status:** line');
  }
} else {
  fail('docs/adr/README.md', 'missing');
}

// --- docs/STATUS.md evidence anchors -------------------------------------
// The anchors are the whole value of the matrix. They used to be `file.ts:NN`, checked
// only for the file existing and being at least NN lines long, and three rows went on
// citing lines that no longer held what their sentence named while this stayed green.
// Each anchor now names a declaration, a test title, a workflow job, a heading or a JSON
// key, and resolves by searching the file (scripts/lib/anchors.mjs). A `:NN` citation
// fails on sight. `--status <file>` points the check at a fixture.
const { values: args } = parseArgs({ options: { status: { type: 'string' } } });
const statusPath = args.status ? resolve(args.status) : join(root, 'docs', 'STATUS.md');
const statusName = relative(root, statusPath);
if (existsSync(statusPath)) {
  const repo = createRepo(root);
  for (const problem of checkInlineAnchors(repo, readFileSync(statusPath, 'utf-8')))
    fail(statusName, problem);
} else {
  fail(statusName, 'missing');
}

// --- One turbo across the root and the images ------------------------------
// Each Dockerfile installs turbo globally to run `turbo prune`, pinned by hand
// beside a comment that says it matches the root devDependency. Nothing checked
// that. The root moved to 2.10.12 and later 2.11.5 while the images stayed on
// 2.10.11, and the drift surfaced only when a turbo.json key the newer version
// added failed to parse inside the older one at image-build time. Compare each
// pin with the version yarn.lock resolved, not with the range in package.json.
const lockPath = join(root, 'yarn.lock');
const lockedTurbo = existsSync(lockPath)
  ? /^"turbo@npm:[^"]*":\n\s+version:\s*(\S+)/m.exec(readFileSync(lockPath, 'utf-8'))?.[1]
  : undefined;
if (lockedTurbo === undefined) {
  fail('turbo version', 'no turbo entry in yarn.lock');
} else if (existsSync(join(root, 'apps'))) {
  for (const app of readdirSync(join(root, 'apps'))) {
    const dockerfile = join(root, 'apps', app, 'Dockerfile');
    if (!existsSync(dockerfile)) continue;
    readFileSync(dockerfile, 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        const m = /npm install -g turbo@(\S+)/.exec(line);
        if (m && m[1] !== lockedTurbo)
          fail(
            `apps/${app}/Dockerfile:${i + 1}`,
            `installs turbo ${m[1]}, but yarn.lock resolves the root's turbo to ${lockedTurbo}`,
          );
      });
  }
}

// --- One Node major across the README, the workflows and the images -------
// docs/STATUS.md asserts these three agree, but that row is the one row citing no
// anchor, so the check above had nothing to resolve and nothing to rot. A
// Dependabot base-image bump then moved the Dockerfiles alone, every gate stayed on
// the old major, and the row went quietly false. Read the major off each surface
// instead of trusting a sentence about them.
const nodeSurfaces = [];

const readmePath = join(root, 'README.md');
if (existsSync(readmePath)) {
  readFileSync(readmePath, 'utf-8')
    .split('\n')
    .forEach((line, i) => {
      const m = /^-\s+Node\.js\s+(\d+)\./.exec(line);
      if (m) nodeSurfaces.push({ where: `README.md:${i + 1}`, major: m[1] });
    });
}

const workflowDir = join(root, '.github', 'workflows');
if (existsSync(workflowDir)) {
  for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    readFileSync(join(workflowDir, file), 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        const where = `.github/workflows/${file}:${i + 1}`;
        // The matrix list first: ci.yml feeds it to `node-version` as an
        // expression, so the literal is only ever in the list.
        const list = /^\s*node:\s*\[([^\]]+)\]/.exec(line);
        if (list) {
          for (const [, major] of list[1].matchAll(/(\d+)\.[\dx]/g))
            nodeSurfaces.push({ where, major });
          return;
        }
        const direct = /node-version:\s*['"]?(\d+)\./.exec(line);
        if (direct) nodeSurfaces.push({ where, major: direct[1] });
      });
  }
}

const appsDir = join(root, 'apps');
if (existsSync(appsDir)) {
  for (const app of readdirSync(appsDir)) {
    const dockerfile = join(appsDir, app, 'Dockerfile');
    if (!existsSync(dockerfile)) continue;
    readFileSync(dockerfile, 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        // Node base images only — the console's runner stage is `FROM nginx:alpine`.
        const m = /^FROM\s+node:(\d+)[.-]/.exec(line);
        if (m) nodeSurfaces.push({ where: `apps/${app}/Dockerfile:${i + 1}`, major: m[1] });
      });
  }
}

if (nodeSurfaces.length === 0) {
  fail('node version', 'found none in README.md, .github/workflows or apps/*/Dockerfile');
} else {
  const counts = new Map();
  for (const { major } of nodeSurfaces) counts.set(major, (counts.get(major) ?? 0) + 1);
  if (counts.size > 1) {
    // Name every surface that disagrees, not the first one found: the fix is to
    // move all of them to one major, which needs the whole list up front.
    const [expected] = [...counts].sort((a, b) => b[1] - a[1])[0];
    for (const { where, major } of nodeSurfaces) {
      if (major !== expected)
        fail(
          where,
          `declares Node ${major}, but ${counts.get(expected)} other surface(s) use ${expected}`,
        );
    }
  }
}

// --- governance/controls.yaml ---------------------------------------------
// In-process rather than chained after this script with `&&`: a renamed declaration that
// breaks a STATUS.md row and a control at once is then reported against both, instead of
// the first failure hiding the second.
const controls = await lintControls({ root, ...defaultPaths(root) });
errors.push(...controls.errors);

// --- Every required check in the ruleset is a job that exists -------------
// scripts/lib/ruleset.mjs says why: a required context that no job reports waits for
// ever and blocks every pull request, and nothing else ties the string to a workflow.
const rulesetPath = join(root, '.github', 'rulesets', 'main.json');
if (existsSync(rulesetPath)) {
  let ruleset;
  try {
    ruleset = JSON.parse(readFileSync(rulesetPath, 'utf-8'));
  } catch (error) {
    fail('.github/rulesets/main.json', `is not valid JSON: ${error.message}`);
  }
  if (ruleset) {
    const workflows = existsSync(workflowDir)
      ? readdirSync(workflowDir)
          .filter((f) => /\.ya?ml$/.test(f))
          .map((file) => ({ file, text: readFileSync(join(workflowDir, file), 'utf-8') }))
      : [];
    for (const problem of checkRuleset(ruleset, workflows))
      fail('.github/rulesets/main.json', problem);
  }
}

// --- Report ---------------------------------------------------------------
if (errors.length) {
  console.error(`\ndocs lint failed with ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}
console.log(
  `docs lint passed: ${byId.size} PRD file(s), ${prdIndex.size} indexed, ADR index consistent, STATUS.md anchors resolve.\n${controls.summary}`,
);
