#!/usr/bin/env node
/**
 * The HL7 FHIR Validator over the prior-authorization dataset and the
 * responses the service specs captured (P3-D, and P3-E for `$inquire`).
 * `fhir-validate.yml` runs it.
 *
 * Two different questions, kept apart:
 *
 *   Gated. Every committed request bundle and every captured response
 *   validates against base R4 4.0.1, and every Patient, Practitioner,
 *   Organization, Coverage and Condition against the US Core 6.1.0 profile
 *   its meta.profile names, with zero errors. A non-zero count exits 1.
 *
 *   Reported. The request bundles against PAS 2.2.1's
 *   profile-pas-request-bundle, the `$submit` response bundles against
 *   profile-pas-response-bundle, and each bundle a `$inquire` returned
 *   (captured on its own as `*.inquiry-return-N.json`) against
 *   profile-pas-inquiry-response-bundle. Every error is sorted into a class, and the
 *   table goes to the job summary. The expected classes are the X12-bound
 *   elements ADR 0008 keeps out of the repository and the profile-choice
 *   errors that follow from them; anything else is printed as `other`, which
 *   is the list a reviewer reads. It does not change the exit code: P3-D
 *   decided the distance to PAS is published, not asserted.
 *
 * Two options are deliberate. `-tx n/a` turns terminology validation off,
 * because a job that calls tx.fhir.org fails whenever that server does.
 * `-allow-example-urls true` accepts `https://example.org/` identifier and code
 * systems, which the validator otherwise rejects as not for production; RFC
 * 2606 reserves the domain, and synthetic data is what it is for (ADR 0008).
 *
 * Usage: node scripts/fhir-validate.mjs --jar <validator_cli.jar> --captured <dir> [--out <dir>]
 * `FHIR_VALIDATOR_JAVA` overrides the java command, for a run in a container.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PINNED = {
  validator: '6.10.4',
  fhir: '4.0.1',
  usCore: 'hl7.fhir.us.core#6.1.0',
  pas: 'hl7.fhir.us.davinci-pas#2.2.1',
};

const PAS = 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition';
const BUNDLES = join(root, 'packages', 'eval-harness', 'datasets', 'prior-auth', 'bundles');

/**
 * The PAS error classes P3-D expects, each with the reason it is expected.
 * The order matters: the first match wins.
 */
export const PAS_CLASSES = [
  {
    name: 'x12: item.extension requestType',
    reason: 'X12 1525, required binding',
    test: (text) => text.includes('extension-serviceItemRequestType'),
  },
  {
    name: 'x12: item.extension certificationType',
    reason: 'X12 1322, required binding',
    test: (text) => text.includes('extension-certificationType'),
  },
  {
    name: 'x12: item.extension cardinality',
    reason: 'the two X12 extensions above, counted',
    test: (text) => text.startsWith('Claim.item.extension: minimum required = 2'),
  },
  {
    name: 'x12: item.category',
    reason: 'X12 1365, required binding',
    test: (text) => text.startsWith('Claim.item.category: minimum required'),
  },
  {
    name: 'x12: outcome queued',
    reason: 'PAS marks a pend with X12 A4 under complete; base R4 queued is used instead',
    test: (text) => text.includes("'queued'") && text.includes('ClaimResponseOutcome'),
  },
  {
    name: 'follows: claim-update branch',
    reason: 'a new request is checked against the update profile too, which needs Claim.related',
    test: (text) => text.startsWith('Claim.related: minimum required'),
  },
  {
    name: 'follows: no Claim profile matched',
    reason: 'the summary of the errors above',
    test: (text) =>
      text.includes('did not match any of the allowed profiles') ||
      text.includes('Unable to find a match for the specified profile'),
  },
];

/** The class of one PAS error, or `other`. */
export function classifyPasError(text) {
  return PAS_CLASSES.find((entry) => entry.test(text))?.name ?? 'other';
}

function args(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const jar = value('--jar');
  const captured = value('--captured');
  if (jar === undefined || captured === undefined) {
    throw new Error(
      'usage: fhir-validate.mjs --jar <validator_cli.jar> --captured <dir> [--out <dir>]',
    );
  }
  return {
    jar: resolve(jar),
    captured: resolve(captured),
    out: resolve(value('--out') ?? join(captured, '..', 'fhir-validate')),
  };
}

function filesIn(dir, suffix) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .sort()
    .map((file) => join(dir, file));
}

/** Runs the validator and returns the per-file OperationOutcomes it wrote. */
function validate(jar, output, flags, files) {
  const java = (process.env['FHIR_VALIDATOR_JAVA'] ?? 'java').split(' ').filter(Boolean);
  const run = spawnSync(
    java[0],
    [
      ...java.slice(1),
      '-jar',
      jar,
      '-version',
      PINNED.fhir,
      '-tx',
      'n/a',
      '-allow-example-urls',
      'true',
      ...flags,
      '-output',
      output,
      ...files,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (!existsSync(output)) {
    process.stderr.write(run.stdout ?? '');
    process.stderr.write(run.stderr ?? '');
    throw new Error(`the validator wrote no ${output} (exit ${run.status})`);
  }
  const bundle = JSON.parse(readFileSync(output, 'utf8'));
  const outcomes =
    bundle.resourceType === 'Bundle' ? bundle.entry.map((entry) => entry.resource) : [bundle];
  return outcomes.map((outcome) => ({
    file:
      outcome.extension?.find((ext) => ext.url.endsWith('operationoutcome-file'))?.valueString ??
      '(unknown)',
    errors: (outcome.issue ?? [])
      .filter((issue) => issue.severity === 'error' || issue.severity === 'fatal')
      .map((issue) => ({
        where: issue.expression?.[0] ?? issue.location?.[0] ?? '',
        text: issue.details?.text ?? issue.diagnostics ?? '',
      })),
  }));
}

function main() {
  const { jar, captured, out } = args(process.argv.slice(2));
  mkdirSync(out, { recursive: true });

  const requests = filesIn(BUNDLES, '.bundle.json');
  const capturedFiles = filesIn(captured, '.json');
  const responses = filesIn(captured, '.response.json');
  const inquiryReturns = capturedFiles.filter((file) => /\.inquiry-return-\d+\.json$/.test(file));
  if (requests.length !== 24)
    throw new Error(`expected 24 request bundles, found ${requests.length}`);
  if (responses.length === 0)
    throw new Error(
      `no captured responses in ${captured}; run the service spec with FHIR_CAPTURE_DIR`,
    );
  if (inquiryReturns.length === 0)
    throw new Error(
      `no captured $inquire returns in ${captured}; run the service specs with FHIR_CAPTURE_DIR`,
    );

  // PAS is loaded for the definition of its careTeamClaimScope extension,
  // which the request bundles carry. meta.profile pins US Core 6.1.0, so
  // the 7.0.0 PAS brings with it is not what the resources are held to.
  const gate = validate(
    jar,
    join(out, 'gate.json'),
    ['-ig', PINNED.usCore, '-ig', PINNED.pas],
    [...requests, ...capturedFiles],
  );
  const gateErrors = gate.flatMap((outcome) =>
    outcome.errors.map((error) => ({ ...outcome, ...error })),
  );

  const pas = [
    ...validate(
      jar,
      join(out, 'pas-request.json'),
      ['-ig', PINNED.pas, '-profile', `${PAS}/profile-pas-request-bundle`],
      requests,
    ),
    ...validate(
      jar,
      join(out, 'pas-response.json'),
      ['-ig', PINNED.pas, '-profile', `${PAS}/profile-pas-response-bundle`],
      responses,
    ),
    ...validate(
      jar,
      join(out, 'pas-inquiry.json'),
      ['-ig', PINNED.pas, '-profile', `${PAS}/profile-pas-inquiry-response-bundle`],
      inquiryReturns,
    ),
  ];
  const tally = new Map();
  const others = [];
  for (const outcome of pas) {
    for (const error of outcome.errors) {
      const name = classifyPasError(error.text);
      tally.set(name, (tally.get(name) ?? 0) + 1);
      if (name === 'other') others.push({ file: outcome.file, ...error });
    }
  }

  const lines = [
    '## FHIR validation (P3-D, P3-E)',
    '',
    `Validator ${PINNED.validator}, FHIR ${PINNED.fhir}, ${PINNED.usCore}, ${PINNED.pas}; terminology off.`,
    '',
    `**Gated — base R4 and US Core 6.1.0:** ${gate.length} file(s), ${gateErrors.length} error(s).`,
    ...gateErrors.map((error) => `- \`${error.file}\` ${error.where}: ${error.text}`),
    '',
    `**Reported — PAS 2.2.1:** ${requests.length} request bundle(s), ${responses.length} response bundle(s), ${inquiryReturns.length} $inquire return bundle(s).`,
    '',
    '| class | errors | why it is expected |',
    '| --- | ---: | --- |',
    ...PAS_CLASSES.map(
      (entry) => `| ${entry.name} | ${tally.get(entry.name) ?? 0} | ${entry.reason} |`,
    ),
    `| other | ${tally.get('other') ?? 0} | not expected: each is listed below |`,
    '',
    ...others.map((error) => `- \`${error.file}\` ${error.where}: ${error.text}`),
  ];
  const summary = `${lines.join('\n')}\n`;
  process.stdout.write(summary);
  if (process.env['GITHUB_STEP_SUMMARY'])
    appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);

  if (gateErrors.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
