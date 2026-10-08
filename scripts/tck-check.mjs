#!/usr/bin/env node
// Holds an A2A TCK run to scripts/tck-expected.txt (P5-A).
//
//   node scripts/tck-check.mjs <junitreport.xml> <tck-expected.txt>
//
// Exits 1 when a test fails that the list does not name, when a test the list
// names passes, and when a test the list names did not run at all. The last
// two are what keep the list from going stale: a fixed failure, or a test the
// TCK renamed, has to come off it in the same change.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match === null ? undefined : decode(match[1]);
}

/**
 * pytest's node id from a JUnit test case: the dotted module path becomes a
 * file path, any classes after it are `::`-joined, then the test's name.
 */
export function nodeId(classname, name) {
  const parts = classname.split('.');
  let module = parts.length - 1;
  while (module > 0 && !parts[module].startsWith('test_')) module -= 1;
  const path = `${parts.slice(0, module + 1).join('/')}.py`;
  return [path, ...parts.slice(module + 1), name].join('::');
}

/** Every test case in a JUnit report, with `passed`, `failed` or `skipped`. */
export function parseJUnit(xml) {
  const cases = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const tag = match[1];
    const body = match[3] ?? '';
    const outcome = /<(failure|error)\b/.test(body)
      ? 'failed'
      : /<skipped\b/.test(body)
        ? 'skipped'
        : 'passed';
    cases.push({ id: nodeId(attribute(tag, 'classname'), attribute(tag, 'name')), outcome });
  }
  return cases;
}

/** `node-id  reason` per line; blank lines and `#` comments ignored. A reason is required. */
export function parseExpected(text) {
  const expected = new Map();
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(\S+)\s+(\S.*)$/.exec(line);
    if (match === null) throw new Error(`tck-expected.txt line ${index + 1} has no reason`);
    expected.set(match[1], match[2]);
  }
  return expected;
}

export function compare(cases, expected) {
  const byId = new Map(cases.map((c) => [c.id, c.outcome]));
  return {
    unexpectedFailures: cases.filter((c) => c.outcome === 'failed' && !expected.has(c.id)),
    expectedButPassed: [...expected.keys()].filter((id) => byId.get(id) === 'passed'),
    expectedButAbsent: [...expected.keys()].filter(
      (id) => !byId.has(id) || byId.get(id) === 'skipped',
    ),
    expectedFailures: cases.filter((c) => c.outcome === 'failed' && expected.has(c.id)),
  };
}

function main([junitPath, expectedPath]) {
  if (junitPath === undefined || expectedPath === undefined) {
    process.stderr.write('usage: tck-check.mjs <junitreport.xml> <tck-expected.txt>\n');
    return 2;
  }
  const cases = parseJUnit(readFileSync(junitPath, 'utf8'));
  const expected = parseExpected(readFileSync(expectedPath, 'utf8'));
  const result = compare(cases, expected);
  const count = (outcome) => cases.filter((c) => c.outcome === outcome).length;

  process.stdout.write(
    `TCK: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped\n`,
  );
  for (const c of result.expectedFailures) {
    process.stdout.write(`  expected failure: ${c.id} — ${expected.get(c.id)}\n`);
  }
  for (const c of result.unexpectedFailures)
    process.stdout.write(`  UNEXPECTED FAILURE: ${c.id}\n`);
  for (const id of result.expectedButPassed) {
    process.stdout.write(`  LISTED BUT PASSED: ${id} — take it off tck-expected.txt\n`);
  }
  for (const id of result.expectedButAbsent) {
    process.stdout.write(`  LISTED BUT NOT RUN: ${id} — the TCK renamed or skipped it\n`);
  }

  const failed =
    result.unexpectedFailures.length +
    result.expectedButPassed.length +
    result.expectedButAbsent.length;
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
