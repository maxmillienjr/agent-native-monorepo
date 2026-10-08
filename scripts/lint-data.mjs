#!/usr/bin/env node
/**
 * The CPT and synthetic-data detector ADR 0003 asked for, against the code
 * systems ADR 0008 permits (P3-D, CTL-DATA-01).
 *
 * Two layers, because a code in a FHIR `Coding` and a number in a sentence
 * need different tests.
 *
 * Layer 1, payer data: structural, no heuristics. Every tracked `.json` under
 * the two dataset roots, plus any tracked `.json` whose top level has a
 * `resourceType`, so a FHIR fixture added anywhere is still checked.
 *
 *   D1  every Coding.system is on ADR 0008's list; CPT fails by name, and an
 *       unknown system fails so that adding one is a decision a reviewer sees
 *   D2  a code under the HCPCS system is Level II outside the D range
 *   D3  a code under ICD-10-CM has the ICD-10-CM shape
 *   D4  no string value, and no token in a decoded plain-text note, has the
 *       shape of a Category I, II, III or PLA code
 *   D5  the synthetic markers: HTEST on every resource, example.org
 *       identifier systems, NPIs that fail their check digit, name parts that
 *       end in digits, 555-01xx telephones, addresses with no line or postcode
 *
 * Layer 2, every tracked text file but `.yarn/` and `yarn.lock`, anchored:
 *
 *   T1  a code-shaped token fails only on a line that says CPT, HCPCS or
 *       ama-assn, or as the value of a JSON key named `code`
 *   T2  a Social Security number shape fails anywhere
 *
 * The false-positive strategy is to anchor, not to enumerate exclusions. The
 * exceptions that remain are `{ file, token, reason }` entries in
 * `scripts/lint-data.allow.json`, and an entry whose token no longer occurs in
 * its file fails, so the list cannot rot.
 *
 * What it does not do: detect real PHI written to look synthetic, proprietary
 * policy text, or a name without digits in prose. Those stay a reviewer's job,
 * which is CTL-DATA-02.
 *
 * Usage: node scripts/lint-data.mjs [--allow <file>] [--files <path>...]
 * With no `--files`, it checks every tracked file. Every problem is reported
 * before it exits 1.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './lib/anchors.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PAYER_DATA_ROOTS = [
  'packages/prior-auth/data/',
  'packages/eval-harness/datasets/prior-auth/',
];

const SYSTEMS = {
  ICD10CM: 'http://hl7.org/fhir/sid/icd-10-cm',
  HCPCS: 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  POS: 'https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code_Set',
  NPI: 'http://hl7.org/fhir/sid/us-npi',
  ACT_REASON: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
};

/** ADR 0008's forbidden systems, named so the failure says which licence. */
const FORBIDDEN = [
  { test: (s) => s.includes('ama-assn.org'), name: 'CPT (AMA licence; ADR 0003)' },
  { test: (s) => s.includes('codesystem.x12.org'), name: 'X12 (copyrighted; ADR 0008)' },
  { test: (s) => s.includes('nubc.org'), name: 'NUBC (AHA copyright; ADR 0008)' },
  { test: (s) => s.startsWith('http://snomed.info/sct'), name: 'SNOMED CT (ADR 0008)' },
];

/** ADR 0008's permitted systems: three exact URIs and three namespaces. */
function permittedSystem(system) {
  return (
    system === SYSTEMS.ICD10CM ||
    system === SYSTEMS.HCPCS ||
    system === SYSTEMS.POS ||
    system.startsWith('http://terminology.hl7.org/CodeSystem/') ||
    system.startsWith('http://hl7.org/fhir/') ||
    system.startsWith('https://example.org/')
  );
}

const HCPCS_LEVEL_II = /^[A-CE-V][0-9]{4}$/;
const ICD10CM_SHAPE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
const CODE_SHAPE = /^(?:[0-9]{5}|[0-9]{4}[FTU])$/;
const CODE_TOKEN = /\b(?:[0-9]{5}|[0-9]{4}[FTU])\b/g;
const SSN_TOKEN = /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g;
const T1_ANCHOR = /\b(?:CPT|HCPCS)\b|ama-assn/;
const FICTIONAL_PHONE = /555-01[0-9]{2}$/;

/** The NPI check: Luhn over the `80840` prefix and all ten digits. */
export function npiCheckDigitValid(npi) {
  const digits = `80840${npi}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/**
 * Layer 1 over one parsed JSON document. `report(rule, token, message)`
 * receives every problem; `token` is the string an allowlist entry names.
 */
export function checkPayerData(document, report) {
  const walk = (node, key) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (typeof node === 'string') {
      if (CODE_SHAPE.test(node)) {
        report('D4', node, `the value \`${node}\` has the shape of a CPT code`);
      }
      return;
    }
    if (!isObject(node)) return;

    if (typeof node.resourceType === 'string') checkResource(node, report);
    if (typeof node.system === 'string' && typeof node.code === 'string') checkCoding(node, report);
    if (typeof node.contentType === 'string' && typeof node.data === 'string') {
      checkAttachment(node, report);
    }

    for (const [childKey, child] of Object.entries(node)) {
      // An attachment's base64 is checked decoded, above; encoded it is not text.
      if (childKey === 'data' && typeof node.contentType === 'string') continue;
      walk(child, childKey);
    }
  };
  walk(document, undefined);
}

function checkCoding(coding, report) {
  const { system, code } = coding;
  const forbidden = FORBIDDEN.find((entry) => entry.test(system));
  if (forbidden !== undefined) {
    report('D1', system, `Coding.system \`${system}\` is ${forbidden.name}, which is forbidden`);
  } else if (!permittedSystem(system)) {
    report('D1', system, `Coding.system \`${system}\` is not on ADR 0008's list`);
  }
  if (system === SYSTEMS.HCPCS && !HCPCS_LEVEL_II.test(code)) {
    report(
      'D2',
      code,
      `\`${code}\` under HCPCS is not Level II outside the D range (five digits is CPT; D is CDT)`,
    );
  }
  if (system === SYSTEMS.ICD10CM && !ICD10CM_SHAPE.test(code)) {
    report('D3', code, `\`${code}\` under ICD-10-CM does not have the ICD-10-CM shape`);
  }
}

function checkAttachment(attachment, report) {
  if (!attachment.contentType.startsWith('text/plain')) return;
  const text = Buffer.from(attachment.data, 'base64').toString('utf8');
  for (const match of text.matchAll(CODE_TOKEN)) {
    report(
      'D4',
      match[0],
      `a plain-text note contains \`${match[0]}\`, which has the shape of a CPT code`,
    );
  }
}

function checkResource(resource, report) {
  const id = typeof resource.id === 'string' ? resource.id : resource.resourceType;
  const security = asArray(resource.meta?.security);
  if (!security.some((c) => c?.system === SYSTEMS.ACT_REASON && c?.code === 'HTEST')) {
    report('D5', id, `${resource.resourceType} \`${id}\` has no meta.security HTEST`);
  }

  for (const identifier of asArray(resource.identifier)) {
    if (!isObject(identifier) || typeof identifier.system !== 'string') continue;
    if (identifier.system === SYSTEMS.NPI) {
      const value = String(identifier.value ?? '');
      if (!/^[0-9]{10}$/.test(value) || npiCheckDigitValid(value)) {
        report('D5', value, `NPI \`${value}\` passes its check digit, so it could be a real one`);
      }
    } else if (!identifier.system.startsWith('https://example.org/')) {
      report(
        'D5',
        identifier.system,
        `identifier.system \`${identifier.system}\` is not under example.org`,
      );
    }
  }

  // HumanName is an array of objects; Organization.name is a string.
  for (const name of Array.isArray(resource.name) ? resource.name : []) {
    if (!isObject(name)) continue;
    const parts = [name.family, ...asArray(name.given), name.text].filter(
      (p) => typeof p === 'string',
    );
    for (const part of parts) {
      if (!/[0-9]$/.test(part)) {
        report('D5', part, `name part \`${part}\` does not end in digits`);
      }
    }
  }

  for (const telecom of asArray(resource.telecom)) {
    if (!isObject(telecom) || !['phone', 'fax', 'sms'].includes(telecom.system)) continue;
    const value = String(telecom.value ?? '');
    if (!FICTIONAL_PHONE.test(value)) {
      report(
        'D5',
        value,
        `telephone \`${value}\` is not in the fictional 555-0100 to 555-0199 range`,
      );
    }
  }

  for (const address of asArray(resource.address)) {
    if (!isObject(address)) continue;
    for (const field of ['line', 'postalCode']) {
      if (address[field] !== undefined) {
        const value = asArray(address[field]).join(' ');
        report('D5', value, `address carries \`${field}\`; payer data stops at city and state`);
      }
    }
  }
}

/** Layer 2 over one text file. */
export function checkText(text, isJson, isCassette, report) {
  text.split('\n').forEach((line, index) => {
    // Encoded content is not text: an embedding vector in a cassette, or an
    // attachment's base64, which layer 1 checks decoded.
    if (isCassette && /"float32Base64"\s*:/.test(line)) return;
    if (isJson && /"data"\s*:\s*"[A-Za-z0-9+/=]*"/.test(line)) return;

    const where = `line ${index + 1}`;
    const anchored = T1_ANCHOR.test(line);
    const codeValue = isJson ? /"code"\s*:\s*"([^"]*)"/.exec(line)?.[1] : undefined;
    for (const match of line.matchAll(CODE_TOKEN)) {
      if (anchored || codeValue === match[0]) {
        report(
          'T1',
          match[0],
          `${where}: \`${match[0]}\` has the shape of a CPT code ` +
            (anchored ? 'on a line that names CPT or HCPCS' : 'as the value of a `code` key'),
        );
      }
    }
    for (const match of line.matchAll(SSN_TOKEN)) {
      report('T2', match[0], `${where}: \`${match[0]}\` has the shape of a Social Security number`);
    }
  });
}

function isPayerData(path, document) {
  return (
    path.endsWith('.json') &&
    (PAYER_DATA_ROOTS.some((prefix) => path.startsWith(prefix)) ||
      (isObject(document) && typeof document.resourceType === 'string'))
  );
}

export const ALLOWLIST = 'scripts/lint-data.allow.json';
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|woff2?|ttf|jar|wasm)$/i;

/**
 * Checks a list of repository-relative paths and returns every problem, each
 * `{ file, rule, token, message }`, with allowlisted ones removed and stale
 * allowlist entries added.
 */
export function lintData(paths, allowlist, base = root) {
  const problems = [];
  const contents = new Map();

  for (const path of paths) {
    // Vendored, binary, or the allowlist itself, whose job is to name tokens.
    if (path.startsWith('.yarn/') || path === 'yarn.lock' || path === ALLOWLIST) continue;
    if (BINARY.test(path)) continue;
    const absolute = join(base, path);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    if (text.includes('\u0000')) continue;
    contents.set(path, text);

    const report = (rule, token, message) => problems.push({ file: path, rule, token, message });

    let document;
    if (path.endsWith('.json')) {
      try {
        document = JSON.parse(text);
      } catch {
        document = undefined;
      }
    }
    if (document !== undefined && isPayerData(path, document)) checkPayerData(document, report);
    checkText(text, path.endsWith('.json'), path.includes('/cassettes/'), report);
  }

  const allowed = (problem) =>
    allowlist.some((entry) => entry.file === problem.file && entry.token === problem.token);
  const remaining = problems.filter((problem) => !allowed(problem));

  for (const entry of allowlist) {
    const text =
      contents.get(entry.file) ??
      (existsSync(join(base, entry.file))
        ? readFileSync(join(base, entry.file), 'utf8')
        : undefined);
    if (text === undefined) {
      remaining.push({
        file: 'scripts/lint-data.allow.json',
        rule: 'ALLOW',
        token: entry.token,
        message: `allows \`${entry.token}\` in \`${entry.file}\`, which does not exist`,
      });
    } else if (!text.includes(entry.token)) {
      remaining.push({
        file: 'scripts/lint-data.allow.json',
        rule: 'ALLOW',
        token: entry.token,
        message: `allows \`${entry.token}\` in \`${entry.file}\`, which no longer contains it; remove the entry`,
      });
    }
  }

  return remaining;
}

export function readAllowlist(path) {
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries))
    throw new Error(`${path} must be an array of { file, token, reason }`);
  for (const entry of entries) {
    if (
      typeof entry.file !== 'string' ||
      typeof entry.token !== 'string' ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length < 10
    ) {
      throw new Error(
        `${path}: every entry needs a file, a token and a reason of at least 10 characters`,
      );
    }
  }
  return entries;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', env: gitEnv() })
    .split('\u0000')
    .filter(Boolean);
}

function main(argv) {
  const allowIndex = argv.indexOf('--allow');
  const allowPath = allowIndex >= 0 ? resolve(argv[allowIndex + 1]) : join(root, ALLOWLIST);
  const filesIndex = argv.indexOf('--files');
  const paths =
    filesIndex >= 0
      ? argv
          .slice(filesIndex + 1)
          .filter((arg) => !arg.startsWith('--'))
          .map((p) => relative(root, resolve(p)))
      : trackedFiles();

  const problems = lintData(paths, readAllowlist(allowPath));
  if (problems.length > 0) {
    console.error(`\ndata lint failed with ${problems.length} problem(s):\n`);
    for (const problem of problems) {
      console.error(`  ✗ ${problem.file}: [${problem.rule}] ${problem.message}`);
    }
    console.error('');
    process.exit(1);
  }
  console.log(`data lint passed: ${paths.length} file(s) checked against ADR 0003 and ADR 0008.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
