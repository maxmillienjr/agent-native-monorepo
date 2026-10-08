import type { LivePool } from './baseline.js';
import type { LiveComparison, LiveVerdict } from './compare-live.js';
import {
  countDifferences,
  type ReplayComparison,
  type ReplayDifference,
} from './compare-replay.js';

/**
 * What the gate decided, as `eval-gate.json` holds it and the job summary
 * prints it.
 *
 * `aborted` is the gate's own verdict on both axes, and it is decided from the
 * output directory rather than the exit code: `eval-abort.json` present, or
 * `eval-report.json` absent, means the suite did not complete and there is
 * nothing to compare.
 */
export type GateResult =
  | {
      readonly axis: 'replay';
      readonly verdict: 'match' | 'differs';
      readonly baseline: string;
      readonly cassetteDigest: string;
      readonly comparison: ReplayComparison;
    }
  | {
      readonly axis: 'replay';
      readonly verdict: 'updated';
      readonly baseline: string;
      readonly cassetteDigest: string;
      readonly cells: number;
    }
  | {
      readonly axis: 'live';
      readonly verdict: LiveVerdict;
      readonly reference: string;
      readonly tally: string;
      readonly pool: LivePool;
      readonly comparison: LiveComparison;
    }
  | {
      readonly axis: 'replay' | 'live';
      readonly verdict: 'aborted';
      readonly reason: string;
    };

export type GateVerdict = GateResult['verdict'];

/**
 * Whether the verdict turns the job red.
 *
 * On replay everything but `match` and `updated` does. On live only
 * `regressed` and `aborted` do: a failed live trial is an expected sample on a
 * stochastic axis, and a nightly that goes red on one is the job people learn
 * to ignore. `insufficient-evidence` and `incomparable` are green with a
 * notice, and are never printed as passing.
 */
export function gateBlocks(result: GateResult): boolean {
  if (result.verdict === 'aborted') return true;
  if (result.axis === 'replay') return result.verdict === 'differs';
  return result.verdict === 'regressed';
}

export function renderGateJson(result: GateResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

const ACCEPT_COMMAND = 'EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval';

/** The section appended to `eval-summary.md`. */
export function renderGateSection(result: GateResult): string {
  const blocks = gateBlocks(result);
  const heading = `### Gate — ${result.axis}: \`${result.verdict}\`${blocks ? ' — blocks' : ''}`;

  if (result.verdict === 'aborted') {
    return [
      heading,
      '',
      `The suite did not complete, so there is nothing to compare: ${result.reason}.`,
      '',
    ].join('\n');
  }

  if (result.axis === 'replay' && result.verdict === 'updated') {
    return [
      '### Gate — replay: baseline updated',
      '',
      `Wrote ${result.cells} cells to \`${result.baseline}\` against cassette set ` +
        `\`${result.cassetteDigest.slice(0, 12)}\`. Nothing was compared. Review the diff and ` +
        'commit it with the change that caused it.',
      '',
    ].join('\n');
  }

  if (result.axis === 'replay') return renderReplay(heading, result);
  return renderLive(heading, result);
}

function renderReplay(
  heading: string,
  result: Extract<GateResult, { axis: 'replay'; verdict: 'match' | 'differs' }>,
): string {
  const { comparison } = result;
  const set = `\`${result.cassetteDigest.slice(0, 12)}\``;

  if (comparison.verdict === 'match') {
    return [
      heading,
      '',
      `All ${comparison.runCells} cells match \`${result.baseline}\` on cassette set ${set}. ` +
        'A replayed run is deterministic, so the comparison is exact: any difference in a ' +
        'label or a value would block.',
      '',
    ].join('\n');
  }

  const counts = countDifferences(comparison.differences);
  const breakdown = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} \`${kind}\``)
    .join(', ');

  const lines = [
    heading,
    '',
    `**${breakdown}** against \`${result.baseline}\` ` +
      `(${comparison.runCells} cells in this run, ${comparison.baselineCells} in the baseline).`,
  ];

  const stale = comparison.differences.find((d) => d.kind === 'stale-digest');
  if (stale !== undefined && stale.kind === 'stale-digest') {
    lines.push(
      '',
      `The cassette set changed (\`${stale.baseline.slice(0, 12)}\` → ` +
        `\`${stale.current.slice(0, 12)}\`) and the baseline was not regenerated beside it.`,
    );
  }

  const cells = comparison.differences.filter(
    (d): d is Exclude<ReplayDifference, { kind: 'stale-digest' }> => d.kind !== 'stale-digest',
  );
  if (cells.length > 0) {
    lines.push(
      '',
      '| Difference | Task | Trial | Grader | Baseline | This run |',
      '| ---------- | ---- | ----- | ------ | -------- | -------- |',
      ...cells.map(
        (d) =>
          `| \`${d.kind}\` | \`${d.cell.task}\` | ${d.cell.trial} | \`${d.cell.grader}\` | ` +
          `${'baseline' in d ? score(d.baseline) : '—'} | ${'run' in d ? score(d.run) : '—'} |`,
      ),
    );
  }

  lines.push(
    '',
    'Every difference blocks, an improvement included: a baseline that kept the old `fail` ' +
      'would later match a regression back to it. If the change is intended, accept it with ' +
      `\`${ACCEPT_COMMAND}\` and commit the baseline diff with it. That needs no key.`,
    '',
  );
  return lines.join('\n');
}

function renderLive(
  heading: string,
  result: Extract<GateResult, { axis: 'live'; verdict: LiveVerdict }>,
): string {
  const { comparison, pool } = result;
  const lines = [
    heading,
    '',
    comparison.reason.charAt(0).toUpperCase() + comparison.reason.slice(1) + '.',
  ];

  if (comparison.regime !== undefined && comparison.estimate !== undefined) {
    const k = comparison.tasks.length;
    lines.push(
      '',
      `**Regime \`${comparison.regime}\`** — ` +
        (comparison.regime === 'tasks-fixed'
          ? `the interval is about these ${k} tasks only, and nothing beyond them.`
          : `per-task differences over ${k} tasks, resampled as a sample of tasks like these.`),
      '',
      `Δ = ${num(comparison.estimate)}, ${Math.round(comparison.confidence * 100)}% interval ` +
        `[${num(comparison.lower!)}, ${num(comparison.upper!)}] over ` +
        `${comparison.resamples.toLocaleString('en-US')} resamples (seed ${comparison.seed}). ` +
        `Margin δ = ${comparison.delta}; floor ${comparison.floor} trials per task in each arm.`,
    );
  } else {
    lines.push(
      '',
      `Margin δ = ${comparison.delta}; floor ${comparison.floor} trials per task in each arm.`,
    );
  }

  if (comparison.tasks.length > 0) {
    lines.push(
      '',
      '| Task | This epoch | Reference | Still needed (epoch / reference) |',
      '| ---- | ---------- | --------- | -------------------------------- |',
      ...comparison.tasks.map(
        (t) =>
          `| \`${t.task}\` | ${t.candidate.passed}/${t.candidate.trials} | ` +
          `${t.reference.passed}/${t.reference.trials} | ` +
          `${t.needs.candidate} / ${t.needs.reference} |`,
      ),
    );
  }

  lines.push('', renderPool(pool));
  lines.push(
    '',
    '> Pooling nights assumes the model behind the alias did not change across them. Until ' +
      "P1-E's canary exists, this comparison cannot tell a provider-side change from a code change.",
    '',
  );
  return lines.join('\n');
}

/**
 * The pooled live rate over one epoch, labelled as what it is: trials from
 * several nights, with the runs that produced them.
 */
export function renderPool(pool: LivePool): string {
  const tasks = Object.values(pool.tasks);
  const counts = tasks.map((task) => task.trials.length);
  const passed = tasks.reduce((acc, task) => acc + task.trials.filter(Boolean).length, 0);
  const total = counts.reduce((acc, n) => acc + n, 0);
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const per = low === high ? `${low}` : `${low}–${high}`;

  return [
    `**Pooled live pass rate: ${total === 0 ? '—' : `${Math.round((passed / total) * 100)}%`} ` +
      `over ${per} trials × ${tasks.length} tasks**, from ${pool.runs.length} run(s) in epoch ` +
      `\`${pool.cassetteDigest.slice(0, 12)}\`:`,
    '',
    ...pool.runs.map((run) => `- \`${run.startedAt}\` at \`${run.gitSha.slice(0, 7)}\``),
  ].join('\n');
}

const num = (value: number): string => (Math.round(value * 1000) / 1000).toString();
const score = (cell: { label: string; value: number }): string =>
  `${cell.label} ${num(cell.value)}`;
