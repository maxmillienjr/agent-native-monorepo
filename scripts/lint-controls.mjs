#!/usr/bin/env node
/**
 * Lint for governance/controls.yaml, and the generator for governance/CONTROLS.md.
 *
 * The catalogue records which safeguards this repository has, which framework clauses
 * each one answers, and what backs it. A catalogue like that is usually a spreadsheet
 * whose evidence column goes stale unnoticed. This makes the stale column a build failure:
 * every control is validated against the schema below, every evidence anchor is resolved
 * against the tracked tree by name (scripts/lib/anchors.mjs), and the PRDs that deliver
 * `planned` controls are cross-checked against the rows they own.
 *
 * What a green run proves is that the evidence exists — a declaration, a test title a
 * pull-request tier runs, a workflow job, a heading. It does not prove the evidence is
 * adequate. The generated matrix says so in its header.
 *
 *   node scripts/lint-controls.mjs            check, and fail if CONTROLS.md is stale
 *   node scripts/lint-controls.mjs --write    check, then regenerate CONTROLS.md
 *
 * `--root`, `--catalogue` and `--matrix` point it at a fixture tree; the tests use them.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import * as prettier from 'prettier';
import {
  LINE_ANCHOR_MESSAGE,
  createRepo,
  resolveSymbol,
  resolveTest,
  resolveCi,
  resolveDoc,
} from './lib/anchors.mjs';
import { frontmatter, prdIndexRows } from './lib/frontmatter.mjs';

// --- Schema ----------------------------------------------------------------------------

const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !/:\d+/.test(p), LINE_ANCHOR_MESSAGE)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be repository-relative');

const Evidence = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('symbol'),
      file: RepoPath,
      name: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('test'),
      file: RepoPath,
      name: z.string().min(1),
      tier: z.enum(['unit', 'service', 'integration', 'e2e']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ci'),
      workflow: z.string().regex(/^[\w-]+\.ya?ml$/),
      job: z.string().min(1),
      run: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('doc'),
      file: RepoPath.refine((p) => p.endsWith('.md'), 'a doc anchor names a Markdown file'),
      heading: z.string().min(1),
    })
    .strict(),
]);

const STATUSES = ['implemented', 'procedural', 'planned', 'not-applicable'];

const Control = z
  .object({
    id: z.string().regex(/^CTL-[A-Z]+-\d{2}$/, 'ids look like CTL-EVAL-01'),
    title: z.string().min(1),
    status: z.enum(STATUSES),
    owner: z
      .string()
      .regex(/^P\d-[A-Z]$/)
      .optional(),
    rationale: z.string().optional(),
    note: z.string().optional(),
    maps: z.array(z.object({ framework: z.string(), ref: z.string() }).strict()).min(1),
    evidence: z.array(Evidence).default([]),
  })
  .strict();

const Framework = z
  .object({
    title: z.string().min(1),
    short: z.string().min(1),
    published: z.string().min(1),
    url: z.string().url(),
    size: z.number().int().positive(),
    unit: z.string().min(1),
    source: z
      .object({
        kind: z.enum(['primary', 'secondary']),
        note: z.string().min(1),
      })
      .strict(),
    clauses: z.record(z.string().min(1)),
  })
  .strict();

const Catalogue = z
  .object({
    frameworks: z.record(z.unknown()),
    controls: z.array(z.unknown()),
  })
  .strict();

const EXECUTABLE = new Set(['test', 'ci']);

// --- Checks ----------------------------------------------------------------------------

/** Zod issues as one line each: `CTL-X-01: evidence[0].file: <message>`. */
const issues = (error, prefix) =>
  error.issues.map((i) => {
    const path = i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');
    return `${prefix}: ${path.replace(/^\./, '') || '(root)'}: ${i.message}`;
  });

/**
 * The status rules. A control that breaks one has no backing the catalogue can stand
 * behind (failure mode (a) in P4-A).
 */
function statusProblems(control, prdIndex) {
  const out = [];
  const kinds = control.evidence.map((e) => e.kind);
  const executable = kinds.some((k) => EXECUTABLE.has(k));
  if (control.status !== 'planned' && control.owner)
    out.push(
      `has an owner (${control.owner}) but is \`${control.status}\` — only planned rows have one`,
    );
  if (control.status !== 'not-applicable' && control.rationale)
    out.push(`has a rationale but is \`${control.status}\` — only not-applicable rows carry one`);
  switch (control.status) {
    case 'implemented':
      if (!executable)
        out.push(
          'is implemented with no test or ci anchor — a symbol or a doc does not fail when the control stops holding',
        );
      break;
    case 'procedural':
      if (!kinds.includes('doc'))
        out.push('is procedural with no doc anchor naming the written rule');
      if (executable)
        out.push(
          'is procedural but has a test or ci anchor — if a check enforces it, it is implemented',
        );
      break;
    case 'planned': {
      if (!control.owner) {
        out.push('is planned with no owner — name the PRD that delivers it');
        break;
      }
      const row = prdIndex.get(control.owner);
      if (!row) out.push(`is planned under ${control.owner}, which is not in the PRD index`);
      else if (row.status === 'shipped')
        out.push(
          `is planned under ${control.owner}, which is shipped — the PRD delivered and the row did not move`,
        );
      break;
    }
    case 'not-applicable':
      if ((control.rationale ?? '').trim().length < 40)
        out.push('is not-applicable without a rationale of at least 40 characters');
      break;
  }
  return out;
}

function evidenceProblem(repo, evidence) {
  switch (evidence.kind) {
    case 'symbol':
      return resolveSymbol(repo, evidence.file, evidence.name);
    case 'test':
      return resolveTest(repo, evidence.file, evidence.name, evidence.tier);
    case 'ci':
      return resolveCi(repo, evidence.workflow, evidence.job, evidence.run).error ?? null;
    case 'doc':
      return resolveDoc(repo, evidence.file, evidence.heading);
  }
}

/** PRD files under docs/prd, with their frontmatter. */
function prdFiles(root) {
  const dir = join(root, 'docs', 'prd');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
    .map((file) => ({ file, fm: frontmatter(readFileSync(join(dir, file), 'utf-8')) ?? {} }))
    .filter(({ fm }) => fm.id);
}

/**
 * Validate and resolve the catalogue. Every problem is collected before returning, as
 * lint-docs.mjs does, so one run names all of them.
 */
export function check({ root, cataloguePath }) {
  const errors = [];
  const where = relative(process.cwd(), cataloguePath) || cataloguePath;
  const fail = (msg) => errors.push(`${where}: ${msg}`);

  if (!existsSync(cataloguePath)) {
    fail('missing');
    return { errors };
  }
  let raw;
  try {
    raw = parseYaml(readFileSync(cataloguePath, 'utf-8'));
  } catch (e) {
    fail(`does not parse: ${e.message.split('\n')[0]}`);
    return { errors };
  }
  const top = Catalogue.safeParse(raw);
  if (!top.success) {
    issues(top.error, 'catalogue').forEach(fail);
    return { errors };
  }

  const repo = createRepo(root);
  const indexPath = join(root, 'docs', 'prd', 'README.md');
  const prdIndex = existsSync(indexPath)
    ? prdIndexRows(readFileSync(indexPath, 'utf-8'))
    : new Map();
  const prds = prdFiles(root);

  const frameworks = new Map();
  for (const [id, value] of Object.entries(top.data.frameworks)) {
    const parsed = Framework.safeParse(value);
    if (parsed.success) frameworks.set(id, parsed.data);
    else issues(parsed.error, `frameworks.${id}`).forEach(fail);
  }

  const controls = [];
  const ids = new Set();
  const declared = new Set();
  const referenced = new Set();
  top.data.controls.forEach((value, i) => {
    const label = typeof value?.id === 'string' ? value.id : `controls[${i}]`;
    // Recorded before validation, so a PRD listing a malformed control is not also told
    // that the catalogue lacks it.
    if (typeof value?.id === 'string') declared.add(value.id);
    const parsed = Control.safeParse(value);
    if (!parsed.success) {
      issues(parsed.error, label).forEach(fail);
      return;
    }
    const control = parsed.data;
    if (ids.has(control.id)) fail(`${control.id}: the id is used twice`);
    ids.add(control.id);

    for (const problem of statusProblems(control, prdIndex)) fail(`${control.id}: ${problem}`);

    for (const { framework, ref } of control.maps) {
      const fw = frameworks.get(framework);
      if (!fw) fail(`${control.id}: maps to framework \`${framework}\`, which the registry lacks`);
      else if (!(ref in fw.clauses))
        fail(
          `${control.id}: maps to \`${ref}\`, which is not a clause of ${framework} — add it to the registry with its text, or fix the ref`,
        );
      else referenced.add(`${framework}\0${ref}`);
    }

    control.evidence.forEach((evidence, j) => {
      const problem = evidenceProblem(repo, evidence);
      if (problem)
        fail(`${control.id}: evidence[${j}] (${evidence.kind}) does not resolve: ${problem}`);
    });
    controls.push(control);
  });

  for (const [id, fw] of frameworks) {
    for (const ref of Object.keys(fw.clauses)) {
      if (!referenced.has(`${id}\0${ref}`))
        fail(
          `frameworks.${id}: clause \`${ref}\` is mapped by no control — the registry holds only mapped clauses`,
        );
    }
  }

  // --- PRDs and the catalogue agree (failure mode (c)) ---------------------------------
  const byId = new Map(controls.map((c) => [c.id, c]));
  for (const { file, fm } of prds) {
    const listed = fm.controls ?? [];
    if (!Array.isArray(listed)) {
      fail(`docs/prd/${file}: \`controls\` must be an inline list`);
      continue;
    }
    for (const id of listed) {
      const control = byId.get(id);
      if (!control) {
        if (!declared.has(id))
          fail(`docs/prd/${file}: lists ${id} in controls, which the catalogue does not have`);
        continue;
      }
      if (fm.status === 'shipped' && control.status === 'planned')
        fail(`${id}: is still planned, but docs/prd/${file} is shipped and lists it`);
      if (control.status === 'planned' && control.owner && control.owner !== fm.id)
        fail(`${id}: is planned under ${control.owner}, but docs/prd/${file} (${fm.id}) lists it`);
    }
  }
  for (const control of controls) {
    if (control.status !== 'planned' || !control.owner) continue;
    const prd = prds.find((p) => p.fm.id === control.owner);
    if (prd && !(prd.fm.controls ?? []).includes(control.id))
      fail(
        `${control.id}: is planned under ${control.owner}, but docs/prd/${prd.file} does not list it in controls`,
      );
  }

  return { errors, frameworks, controls, repo, prds, prdIndex };
}

// --- The generated matrix --------------------------------------------------------------

const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const code = (s) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

function evidenceCell(evidence, repo, link) {
  switch (evidence.kind) {
    case 'symbol':
      return `[${code(evidence.name)}](${link(evidence.file)})`;
    case 'test':
      return `test [${code(`'${evidence.name}'`)}](${link(evidence.file)}) (${evidence.tier})`;
    case 'ci': {
      const { triggers } = resolveCi(repo, evidence.workflow, evidence.job, evidence.run);
      const run = evidence.run ? `, runs ${code(evidence.run)}` : '';
      return (
        `[${code(evidence.workflow)}](${link(`.github/workflows/${evidence.workflow}`)}) ` +
        `job ${code(evidence.job)}${run} — on ${triggers.join(', ')}`
      );
    }
    case 'doc':
      return `[${code(evidence.file)}](${link(evidence.file)}) § ${evidence.heading}`;
  }
}

/** The matrix as Markdown, formatted by the repository's Prettier config. */
export async function render({ frameworks, controls, repo }, matrixPath) {
  const matrixDir = posix.dirname(relative(repo.root, matrixPath).split('\\').join('/'));
  const link = (path) => posix.relative(matrixDir, path);
  const count = (status) => controls.filter((c) => c.status === status).length;
  const secondary = [...frameworks].filter(([, fw]) => fw.source.kind === 'secondary');
  const dagger = (id) => (frameworks.get(id)?.source.kind === 'secondary' ? '†' : '');

  const out = [];
  out.push(
    '<!-- Generated from governance/controls.yaml by `yarn controls:matrix`. Do not edit by hand: `yarn lint:docs` fails when this file differs from what the catalogue renders. -->',
    '',
    '# Controls',
    '',
    `${controls.length} controls: ${STATUSES.map((s) => `${count(s)} \`${s}\``).join(', ')}.`,
    '',
    '**A green check means the evidence resolves, not that it is sufficient.** `yarn lint:docs` ' +
      'proves that each anchor below exists at HEAD: the symbol is declared, the test title is ' +
      'present and not skipped in a tier a pull-request workflow runs, the workflow job exists and ' +
      'runs the named command, the heading is there. It does not prove that a test asserts what its ' +
      'control claims, that a threshold is right, or that a mapping to a clause is the best one. ' +
      'Those are judgements, and each sits beside its evidence so a reader can disagree with it.',
    '',
    '**Coverage is not claimed.** The check asserts that every catalogued control has evidence, not ' +
      'that every clause of a framework has a control. Each framework section below says how many of ' +
      'its clauses no control here addresses.',
    '',
  );
  if (secondary.length) {
    out.push(`† ${secondary.map(([, fw]) => fw.source.note).join(' ')}`, '');
  }
  out.push(
    '| Status | Means |',
    '| --- | --- |',
    '| `implemented` | A test or a CI job fails if the control stops holding. |',
    '| `procedural` | A person enforces it by applying a written rule. No check does. |',
    '| `planned` | Not delivered. The owner is the PRD that delivers it. |',
    '| `not-applicable` | Excluded, with the justification a Statement of Applicability requires. |',
    '',
    '## Catalogue',
    '',
    '| Id | Control | Status | Maps to | Evidence, owner or rationale |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const control of controls) {
    const maps = [];
    for (const [id, fw] of frameworks) {
      const refs = control.maps.filter((m) => m.framework === id).map((m) => m.ref);
      if (refs.length) maps.push(`${fw.short} ${refs.join(', ')}${dagger(id)}`);
    }
    const parts = [];
    // The owner's id only. Its status or whether it has a file yet would make this matrix
    // stale whenever another PRD moved, and fail a pull request that never touched it.
    if (control.status === 'planned') parts.push(`Owner: ${control.owner}`);
    if (control.status === 'not-applicable') parts.push(`Rationale: ${control.rationale}`);
    for (const evidence of control.evidence) parts.push(evidenceCell(evidence, repo, link));
    if (control.note) parts.push(control.note);
    out.push(
      `| ${control.id} | ${cell(control.title)} | \`${control.status}\` | ${cell(maps.join('; '))} | ${cell(parts.join('; '))} |`,
    );
  }
  out.push('', '## Frameworks', '');
  for (const [id, fw] of frameworks) {
    const refs = Object.keys(fw.clauses);
    out.push(
      `### ${fw.title}`,
      '',
      `Registry id \`${id}\`, edition of ${fw.published}. Source: <${fw.url}>.`,
      '',
      `**${refs.length} of ${fw.size} ${fw.unit} referenced; ${fw.size - refs.length} not assessed.** ${fw.source.note}`,
      '',
      '| Clause | Text | Controls |',
      '| --- | --- | --- |',
    );
    for (const ref of refs) {
      const users = controls
        .filter((c) => c.maps.some((m) => m.framework === id && m.ref === ref))
        .map((c) => c.id);
      out.push(`| ${cell(ref)}${dagger(id)} | ${cell(fw.clauses[ref])} | ${users.join(', ')} |`);
    }
    out.push('');
  }
  // This repository's Prettier config, wherever the matrix is written: a fixture tree
  // copied to a temporary directory must render byte-for-byte what it renders in place.
  const options = (await prettier.resolveConfig(fileURLToPath(import.meta.url))) ?? {};
  return prettier.format(out.join('\n'), { ...options, parser: 'markdown' });
}

// --- CLI -------------------------------------------------------------------------------

/**
 * Check the catalogue and the matrix. Returns every problem found and a one-line summary;
 * with `write`, regenerates the matrix instead of comparing it. lint-docs.mjs calls this
 * in-process, so one `yarn lint:docs` run reports a broken anchor in STATUS.md and the
 * control it breaks together.
 */
export async function lintControls({ root, cataloguePath, matrixPath, write = false }) {
  const matrixName = relative(root, matrixPath);
  const result = check({ root, cataloguePath });
  const { errors } = result;
  // The matrix is rendered only from a catalogue with no other problem: a stale-matrix
  // error on top of a broken catalogue would name the symptom instead of the cause.
  if (errors.length === 0) {
    const rendered = await render(result, matrixPath);
    if (write) {
      writeFileSync(matrixPath, rendered);
    } else if (!existsSync(matrixPath) || readFileSync(matrixPath, 'utf-8') !== rendered) {
      errors.push(`${matrixName} is stale — run yarn controls:matrix`);
    }
  }
  if (errors.length) return { errors, summary: null };
  const counts = STATUSES.map(
    (s) => `${result.controls.filter((c) => c.status === s).length} ${s}`,
  ).join(', ');
  return {
    errors,
    summary:
      `controls lint passed: ${result.controls.length} control(s) (${counts}), every anchor resolves` +
      (write ? `; wrote ${matrixName}.` : `, ${matrixName} is current.`),
  };
}

/** The catalogue and matrix paths under a root, as lint-docs.mjs and the CLI default them. */
export const defaultPaths = (root) => ({
  cataloguePath: join(root, 'governance', 'controls.yaml'),
  matrixPath: join(root, 'governance', 'CONTROLS.md'),
});

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({
    options: {
      write: { type: 'boolean', default: false },
      root: { type: 'string' },
      catalogue: { type: 'string' },
      matrix: { type: 'string' },
    },
  });
  const root = resolve(values.root ?? repoRoot);
  const defaults = defaultPaths(root);
  const { errors, summary } = await lintControls({
    root,
    cataloguePath: resolve(values.catalogue ?? defaults.cataloguePath),
    matrixPath: resolve(values.matrix ?? defaults.matrixPath),
    write: values.write,
  });
  if (errors.length) {
    console.error(`\ncontrols lint failed with ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error('');
    process.exit(1);
  }
  console.log(summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
