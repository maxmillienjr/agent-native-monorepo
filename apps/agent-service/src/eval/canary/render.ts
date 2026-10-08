import { RE_RECORD_COMMAND, UPDATE_BASELINE_COMMAND } from '../abort-cause.js';
import { CANARY_BASELINE_FILE, CANARY_UPDATE_COMMAND, type CanaryBaseline } from './baseline.js';
import type { ProbeResult } from './probes.js';
import type { CanaryAbort, CanaryReport, RequestCounts } from './runner.js';

const cell = (value: string | undefined): string =>
  value === undefined ? '—' : `\`${value.replace(/`/g, "'").replace(/\|/g, '\\|')}\``;

function describeRequests(requests: RequestCounts): string {
  return (
    `**Requests:** ${requests.metadata} \`models.get\`, ${requests.generateContent} ` +
    `\`generateContent\`, ${requests.embedContent} \`embedContent\`` +
    (requests.other > 0 ? `, ${requests.other} other` : '') +
    '.'
  );
}

function table(results: readonly ProbeResult[]): string[] {
  return [
    '| Probe | Id | Verdict | Baseline | Observed |',
    '| ----- | -- | ------- | -------- | -------- |',
    ...results.map(
      (result) =>
        `| ${result.probe} | \`${result.id}\`${result.pinned ? '' : ' (floating)'} | ` +
        `**${result.verdict}** | ${cell(result.baseline)} | ${cell(result.observed)} |`,
    ),
  ];
}

/**
 * The job-summary Markdown for a completed canary run.
 *
 * The heading is the exit: `unchanged` or `drift`. What changed is in the
 * table, the way back to green is under it, and the sentence a reader of a
 * replayed or recorded number needs — since when the embedding model has
 * returned the same vectors — is on the page whenever it is true.
 */
export function renderCanarySummary(report: CanaryReport, baseline: CanaryBaseline): string {
  const failing = report.results.filter(
    (result) =>
      result.pinned &&
      (result.verdict === 'changed' ||
        result.verdict === 'gone' ||
        result.verdict === 'unobserved'),
  );
  const lines: string[] = [
    `## Canary — ${report.result === 'passed' ? 'unchanged' : 'drift'}`,
    '',
    describeRequests(report.requests),
  ];

  if (report.notRun.length > 0) {
    lines.push(
      '',
      `> **Not run (CANARY_PROBES):** ${report.notRun.join(', ')}. ` +
        'This run says nothing about them, and a run in CI leaves out none.',
    );
  }

  lines.push('', ...table(report.results));

  const embedding = report.results.find((result) => result.probe === 'embedding');
  if (embedding?.verdict === 'unchanged') {
    lines.push(
      '',
      `The embedding model \`${embedding.id}\` has returned identical vectors since ` +
        `${baseline.embedding.since}, on all ${baseline.embedding.probes.length} baseline texts.`,
    );
  }

  for (const result of report.results) {
    if (result.detail !== undefined && result.verdict !== 'unchanged') {
      lines.push('', `- \`${result.id}\` (${result.probe}): ${result.detail}`);
    }
  }

  const floating = report.results.filter(
    (result) => !result.pinned && result.verdict !== 'unchanged',
  );
  for (const result of floating) {
    lines.push(
      '',
      `> **Notice:** the floating alias \`${result.id}\` is \`${result.verdict}\` on ${result.probe}` +
        (result.observed === undefined ? '' : `, now \`${result.observed}\``) +
        '. This is information about the next model, not drift in the pinned one, and it ' +
        'does not fail the run.',
    );
  }

  const usage = Object.entries(report.usage);
  if (usage.length > 0) {
    lines.push('', '**Usage, as returned:**');
    for (const [id, counts] of usage) {
      lines.push(`- \`${id}\`: \`${JSON.stringify(counts)}\``);
    }
  }

  if (report.baselineUpdated) {
    lines.push(
      '',
      `**The baseline was rewritten** from this run. Commit \`${CANARY_BASELINE_FILE}\`; the diff is ` +
        'the acknowledged change.',
    );
  }

  if (failing.length > 0 && !report.baselineUpdated) {
    lines.push(
      '',
      '### Back to green',
      '',
      `- A change behind a pinned id is acknowledged by a committed baseline update: ` +
        `\`${CANARY_UPDATE_COMMAND}\` with a key, then commit \`${CANARY_BASELINE_FILE}\`.`,
      '- A changed pinned model also stales the recorded cassettes, which replay its old ' +
        `answers: re-record with \`${RE_RECORD_COMMAND}\` and regenerate the replay baseline ` +
        `with \`${UPDATE_BASELINE_COMMAND}\`.`,
      '- `gone` and `unobserved` cannot be accepted by an update. A retired id is a migration; ' +
        'a missing `modelVersion` is a change in the response, and the probe is what to fix.',
    );
  }

  return `${lines.join('\n')}\n`;
}

/** A fence longer than any run of backticks in the text, so a message cannot close it. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The job-summary Markdown for a canary run that did not complete. */
export function renderCanaryAbortSummary(abort: CanaryAbort): string {
  const marker = fence(abort.error.message);
  const lines: string[] = [
    '## Canary — aborted',
    '',
    'The run did not complete, so no `canary-report.json` was written and no verdict exists.',
    '',
    describeRequests(abort.requests),
    '',
    `**Error:** \`${abort.error.name}\`${abort.error.status === undefined ? '' : ` (HTTP ${abort.error.status})`}`,
    '',
    marker,
    abort.error.message,
    marker,
  ];
  if (abort.cause !== undefined) {
    lines.push('', `**Cause (\`${abort.cause.code}\`):** ${abort.cause.summary}`);
    if (abort.cause.remedy !== undefined) lines.push('', `**Remedy:** ${abort.cause.remedy}`);
  }
  if (abort.completed.length > 0) {
    lines.push('', '**Probes that completed before the abort:**', '', ...table(abort.completed));
  }
  return `${lines.join('\n')}\n`;
}
