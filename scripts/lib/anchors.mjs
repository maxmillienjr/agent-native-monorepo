/**
 * Evidence anchors that resolve by name, not by line.
 *
 * `docs/STATUS.md` used to cite `file.ts:NN`, and the check behind it confirmed only that
 * the file existed and was at least NN lines long. Three rows went on citing lines that no
 * longer held what their sentence named, and the check stayed green (P4-A, Problem). An
 * anchor here names the thing instead — a declaration, a test title, a workflow job, a
 * heading — and resolves by searching the file's text. It keeps resolving when the lines
 * above it move, and it fails when the named thing is renamed or removed.
 *
 * Every resolver returns `null` when the anchor resolves and a sentence saying why when it
 * does not. `governance/controls.yaml` and `docs/STATUS.md` both resolve through here.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const LINE_ANCHOR_MESSAGE = 'line anchors rot — name a symbol, a test or a heading';

/**
 * The environment for a git call that must find its repository from `cwd`. Git exports
 * `GIT_DIR` and `GIT_INDEX_FILE` to hooks and to `rebase --exec`, and an inherited one
 * overrides discovery: `git ls-files` in a fixture tree would list the enclosing
 * repository's index instead.
 */
export function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

/** The tracked tree under `root`, with cached reads. Paths are relative to `root`. */
export function createRepo(root) {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf-8', env: gitEnv() })
      .split('\0')
      .filter(Boolean),
  );
  const cache = new Map();
  return {
    root,
    tracked,
    has: (path) => tracked.has(path),
    read(path) {
      if (!cache.has(path)) cache.set(path, readFileSync(join(root, path), 'utf-8'));
      return cache.get(path);
    },
  };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// --- symbol ----------------------------------------------------------------

const declaration = (name) =>
  new RegExp(
    '^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?' +
      `(?:function\\*?|class|const|let|interface|type|enum)\\s+${escape(name)}(?![\\w$])`,
  );

const member = (name) =>
  new RegExp(
    '^\\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\\s+)*' +
      `\\*?${escape(name)}\\s*\\??\\s*[(<:=]`,
  );

/**
 * `name` is declared on exactly one line of `file`. `Owner.member` names a method or a
 * property inside a class or an object literal: the owner resolves as above, and exactly
 * one line of its body — up to the next line that closes a block at column 0 — declares
 * the member.
 */
export function resolveSymbol(repo, file, name) {
  if (!repo.has(file)) return `\`${file}\` is not a tracked file`;
  const lines = repo.read(file).split('\n');
  const [owner, memberName] = name.split('.');
  const hits = lines.flatMap((line, i) => (declaration(owner).test(line) ? [i] : []));
  if (hits.length !== 1)
    return `\`${owner}\` is declared on ${plural(hits.length, 'line')} of ${file}, not 1`;
  if (!memberName) return null;
  let end = hits[0] + 1;
  while (end < lines.length && !/^[})\]]/.test(lines[end])) end++;
  const body = lines.slice(hits[0] + 1, end);
  const members = body.filter((line) => member(memberName).test(line)).length;
  if (members !== 1)
    return `\`${memberName}\` is declared on ${plural(members, 'line')} of \`${owner}\` in ${file}, not 1`;
  return null;
}

// --- test ------------------------------------------------------------------

const TEST_CALL =
  /\b(it|test|describe)((?:\.(?:only|skip|todo|concurrent|sequential|fails|skipIf\([^)]*\)|runIf\([^)]*\)))*)\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;

/** Every `it(`, `test(` and `describe(` call in `text`, with its title and modifiers. */
export function testCalls(text) {
  return [...text.matchAll(TEST_CALL)].map(([, fn, modifiers, , raw]) => ({
    fn,
    modifiers,
    title: raw.replace(/\\(.)/g, '$1'),
  }));
}

/** The nearest `package.json` above `file` that is not the repository root's. */
function workspaceOf(repo, file) {
  let dir = posix.dirname(file);
  while (dir !== '.' && dir !== '/') {
    if (existsSync(join(repo.root, dir, 'package.json'))) return dir;
    dir = posix.dirname(dir);
  }
  return null;
}

/** Workflows under `.github/workflows/`, parsed, with their triggers. */
export function workflows(repo) {
  return [...repo.tracked]
    .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
    .map((path) => {
      const doc = parseYaml(repo.read(path)) ?? {};
      return { path, doc, triggers: triggersOf(doc.on) };
    });
}

function triggersOf(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
}

const runsTier = (run, tier) =>
  new RegExp(`\\bturbo\\s+(?:run\\s+)?test:${escape(tier)}(?![\\w:-])`).test(run);

/**
 * Exactly one test call in `file` has `name` as its title, and it is not `.skip`/`.todo`.
 * With `tier`, the file's workspace also declares `test:<tier>` and a workflow triggered on
 * `pull_request` runs `turbo test:<tier>` — so the title is one a pull request executes.
 * The runner's `include` globs are not consulted; P4-A names that residual.
 */
export function resolveTest(repo, file, name, tier) {
  if (!repo.has(file)) return `\`${file}\` is not a tracked file`;
  const calls = testCalls(repo.read(file)).filter((c) => c.title === name);
  if (calls.length !== 1)
    return `test title '${name}' matches ${plural(calls.length, 'call')} in ${file}, not 1`;
  if (/\.(?:skip|todo|skipIf)\b/.test(calls[0].modifiers))
    return `test '${name}' in ${file} is \`${calls[0].fn}${calls[0].modifiers}\`, which does not run`;
  if (tier === undefined) return null;
  const workspace = workspaceOf(repo, file);
  if (!workspace) return `${file} is not inside a workspace with its own package.json`;
  const manifest = JSON.parse(repo.read(`${workspace}/package.json`));
  if (!manifest.scripts?.[`test:${tier}`])
    return `${workspace}/package.json declares no \`test:${tier}\` script, so ${file} is in no ${tier} run`;
  const gate = workflows(repo).find(
    (w) =>
      w.triggers.includes('pull_request') &&
      Object.values(w.doc.jobs ?? {}).some((job) =>
        (job?.steps ?? []).some(
          (step) => typeof step?.run === 'string' && runsTier(step.run, tier),
        ),
      ),
  );
  if (!gate) return `no workflow triggered on pull_request runs \`turbo test:${tier}\``;
  return null;
}

// --- ci --------------------------------------------------------------------

/**
 * `.github/workflows/<workflow>` parses, `jobs.<job>` exists, and when `run` is given one of
 * the job's steps has a `run:` containing it. Returns `{ error }` or `{ triggers }`, because
 * the matrix prints the triggers: a nightly-only job is not a gate.
 */
export function resolveCi(repo, workflow, job, run) {
  const path = `.github/workflows/${workflow}`;
  if (!repo.has(path)) return { error: `\`${path}\` is not a tracked workflow` };
  let doc;
  try {
    doc = parseYaml(repo.read(path)) ?? {};
  } catch (e) {
    return { error: `${path} does not parse: ${e.message.split('\n')[0]}` };
  }
  const found = doc.jobs?.[job];
  if (!found) return { error: `${path} has no job \`${job}\`` };
  if (run !== undefined) {
    const steps = found.steps ?? [];
    if (!steps.some((s) => typeof s?.run === 'string' && s.run.includes(run)))
      return { error: `job \`${job}\` in ${path} has no step whose run contains \`${run}\`` };
  }
  return { triggers: triggersOf(doc.on) };
}

// --- doc -------------------------------------------------------------------

/** Markdown headings outside fenced code blocks, as their literal text. */
export function headings(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) out.push(h[1]);
  }
  return out;
}

export function resolveDoc(repo, file, heading) {
  if (!/\.md$/.test(file)) return `\`${file}\` is not Markdown`;
  if (!repo.has(file)) return `\`${file}\` is not a tracked file`;
  if (!headings(repo.read(file)).includes(heading)) return `${file} has no heading \`${heading}\``;
  return null;
}

// --- json key --------------------------------------------------------------

/** A dotted key path exists in a JSON file. Used by `docs/STATUS.md` for config claims. */
export function resolveJsonKey(repo, file, keyPath) {
  if (!repo.has(file)) return `\`${file}\` is not a tracked file`;
  let node;
  try {
    node = JSON.parse(repo.read(file));
  } catch (e) {
    return `${file} does not parse as JSON: ${e.message}`;
  }
  for (const key of keyPath.split('.')) {
    if (node === null || typeof node !== 'object' || !(key in node))
      return `${file} has no key \`${keyPath}\``;
    node = node[key];
  }
  return null;
}

// --- inline anchors, as docs/STATUS.md writes them ----------------------------

const TEST_FILE = /\.(?:test|spec|e2e-spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const WORKFLOW = /^\.github\/workflows\/([^/]+\.ya?ml)$/;

/**
 * An inline anchor is one code span, `` `path#anchor` ``, and what the anchor names depends
 * on the file: a job id in a workflow, a heading in Markdown, a test title in a test file,
 * a key path in JSON, and a declaration in any other source file. `path` may be a suffix of
 * the tracked path, as the matrix has always written it, but it must match exactly one
 * file.
 */
export function resolveInline(repo, span) {
  const hash = span.indexOf('#');
  const path = span.slice(0, hash);
  const anchor = span.slice(hash + 1);
  const matches = [...repo.tracked].filter((f) => f === path || f.endsWith(`/${path}`));
  if (matches.length === 0) return `\`${path}\` matches no tracked file`;
  if (matches.length > 1) return `\`${path}\` is ambiguous (${matches.length} tracked matches)`;
  const [file] = matches;
  const workflow = WORKFLOW.exec(file);
  if (workflow) return resolveCi(repo, workflow[1], anchor).error ?? null;
  if (file.endsWith('.md')) return resolveDoc(repo, file, anchor);
  if (TEST_FILE.test(file)) return resolveTest(repo, file, anchor);
  if (file.endsWith('.json')) return resolveJsonKey(repo, file, anchor);
  if (SOURCE_FILE.test(file)) return resolveSymbol(repo, file, anchor);
  return `\`${file}\` has no anchor resolver — cite the file without \`#\``;
}

/**
 * Every inline anchor in a Markdown text, resolved. A `path:NN` citation is an error in
 * itself. Returns a list of problems, each naming the span.
 */
export function checkInlineAnchors(repo, text) {
  const problems = [];
  const seen = new Set();
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    if (seen.has(span)) continue;
    seen.add(span);
    if (/^[\w./-]+\.[A-Za-z]+:\d+(?:-\d+)?$/.test(span)) {
      problems.push(`cites \`${span}\` — ${LINE_ANCHOR_MESSAGE}`);
      continue;
    }
    if (!/^[\w./-]+\.[A-Za-z]+#.+$/.test(span)) continue;
    const error = resolveInline(repo, span);
    if (error) problems.push(`\`${span}\` does not resolve: ${error}`);
  }
  return problems;
}
