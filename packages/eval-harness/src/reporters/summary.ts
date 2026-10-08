import type { CostEstimate, SuiteReport, TrialUsage } from '../types.js';

const tick = (value: boolean): string => (value ? '✅' : '❌');
const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

/**
 * The k the trials were actually run at.
 *
 * The suite's figure alone is a lie the moment a task caps itself below it, which
 * is what every replayed task does — and `pass^k` read against the wrong k is the
 * misreading the cap exists to prevent.
 */
function describeTrials(report: SuiteReport<unknown>): string {
  const counts = report.tasks.map((task) => task.trialsPerTask);
  if (counts.length === 0 || counts.every((count) => count === report.trialsPerTask)) {
    return `**${report.trialsPerTask} trial(s) per task**`;
  }

  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const spread = low === high ? `${low}` : `${low}–${high}`;
  return `**${spread} trial(s) per task**, capped below the suite's ${report.trialsPerTask}`;
}

/**
 * A GitHub job-summary Markdown table.
 *
 * The axes line is first and is not optional. A suite run on the stub model set
 * or against no database reports numbers that look exactly like a working one's,
 * and the axes are the only thing on the page that distinguishes them.
 *
 * The exclusion sits between the rate and the table for the same reason. A rate
 * computed over fewer tasks reads higher, so a reader must not be able to reach
 * the number without reaching what was left out of it.
 */
export function renderMarkdownSummary(report: SuiteReport<unknown>): string {
  const graderNames = [
    ...new Set(report.tasks.flatMap((task) => Object.keys(task.perGraderPassRate))),
  ];
  const ranCount = report.tasks.length;
  const taskCount = ranCount + report.skipped.length;

  const lines: string[] = [
    `## Eval — ${report.suite}`,
    '',
    `**Axes:** model \`${report.axes.model}\`, memory \`${report.axes.memory}\` · ` +
      `${describeTrials(report)} · ` +
      `**overall pass rate ${percent(report.passRate)}**` +
      (report.skipped.length > 0 ? ` over ${ranCount} of ${taskCount} tasks` : ''),
  ];

  // Beside the axis line rather than at the foot of the page: on the replay
  // axis the rate is a property of the recording as much as of the code, and a
  // reader who reaches the number without reaching the date of the set has no
  // way to tell a regression from a cassette recorded before a prompt edit.
  if (report.replay !== undefined) {
    lines.push(
      '',
      `**Replayed from ${report.replay.cassettes} cassette(s)** recorded ` +
        `\`${report.replay.recordedAt}\` at \`${report.replay.gitSha}\`. ` +
        'A replayed `pass^k` is a frozen sample, not a reliability measurement.',
    );
  }

  // Under the axes and the recording: the axis says a model answered, and
  // this says which. A run on the floating alias reads like one on the pinned id
  // otherwise, and the rate means something different for each (P1-E).
  if (report.models !== undefined) {
    lines.push(
      '',
      `**Models:** chat \`${report.models.chat}\`, embedding \`${report.models.embedding}\``,
    );
  }

  if (report.skipped.length > 0) {
    lines.push(
      '',
      `> **Not run on these axes — excluded from the rate above:**`,
      ...report.skipped.map(
        (skipped) => `> - \`${skipped.taskId}\` — ${skipped.problems.join('; ')}`,
      ),
    );
  }

  // Where the exclusions are, because it is one: on the stub axis nothing a
  // trial used can be read, and a run that checked no budget must not read as
  // one that was within all of them.
  if (!report.usage.checked && report.usage.reason !== undefined) {
    lines.push('', `> **Budgets:** ${report.usage.reason}.`);
  }

  lines.push(
    '',
    '| Task | pass@k | pass^k | Trials passed |',
    '| ---- | ------ | ------ | ------------- |',
  );

  for (const task of report.tasks) {
    const passed = task.trials.filter((trial) => trial.passed).length;
    lines.push(
      `| \`${task.taskId}\` | ${tick(task.passAtK)} | ${tick(task.passHatK)} | ${passed}/${task.trials.length} |`,
    );
  }

  // In the table as well as above it: a task that vanishes from the only list
  // of tasks on the page is indistinguishable from a task that never existed.
  for (const skipped of report.skipped) {
    lines.push(`| \`${skipped.taskId}\` | ⏭️ skipped | ⏭️ skipped | not run |`);
  }

  if (graderNames.length > 0) {
    lines.push('', '### Per-grader pass rate', '');
    lines.push(`| Grader | ${report.tasks.map((task) => `\`${task.taskId}\``).join(' | ')} |`);
    lines.push(`| ------ | ${report.tasks.map(() => '------').join(' | ')} |`);
    for (const grader of graderNames) {
      const cells = report.tasks.map((task) => {
        const rate = task.perGraderPassRate[grader];
        return rate === undefined ? '—' : percent(rate);
      });
      lines.push(`| \`${grader}\` | ${cells.join(' | ')} |`);
    }
  }

  if (report.usage.checked) lines.push(...budgetSection(report), ...usageSection(report));

  if (report.uncalibratedGraders.length > 0) {
    lines.push(
      '',
      `> **Uncalibrated judges:** ${report.uncalibratedGraders.map((n) => `\`${n}\``).join(', ')}.`,
      '> Their true-positive and true-negative rates have not been measured against human labels.',
    );
  }

  // At the foot, below the exclusions a reader must reach first. The spans
  // and evaluation events in `eval-report.json` follow these conventions,
  // which are in Development status, so two reports compare attribute for
  // attribute only when this matches.
  lines.push(
    '',
    `Spans and evaluation events follow the GenAI semantic conventions at \`${report.genAiSemconvCommit}\`.`,
  );

  lines.push('');
  return lines.join('\n');
}

const number = (value: number | null): string => (value === null ? 'unmeasurable' : `${value}`);

function describeCost(cost: CostEstimate): string {
  const parts: string[] = [];
  if (cost.usd !== null) parts.push(`$${cost.usd.toFixed(4)}`);
  if (cost.unpricedModels.length > 0) {
    parts.push(`unpriced: ${cost.unpricedModels.map((model) => `\`${model}\``).join(', ')}`);
  }
  return parts.length === 0 ? 'unpriced' : parts.join(' + ');
}

/**
 * Budgets beside the pass rate (P1-F): one row per budget per trial, and the
 * count of breaches, which fails the run on its own.
 */
function budgetSection(report: SuiteReport<unknown>): string[] {
  const rows = report.tasks.flatMap((task) =>
    task.trials.flatMap((trial) =>
      trial.budgets.map(
        (budget) =>
          `| \`${task.taskId}\` | ${trial.index + 1} | \`${budget.budget}\` | ${budget.limit} | ` +
          `${number(budget.actual)} | ${budget.label === 'within' ? '✅ within' : `❌ ${budget.label}`} | ` +
          `${budget.source ?? '—'} |`,
      ),
    ),
  );

  const lines = ['', '### Budgets', ''];
  if (rows.length === 0) {
    lines.push('No task that ran declares a budget.');
    return lines;
  }

  lines.push(
    report.budgetBreaches === 0
      ? 'Every declared budget is within its ceiling.'
      : `**${report.budgetBreaches} budget breach(es).** A breach fails the run whatever the pass ` +
          'rate says: the trials above passed or failed on their graders alone, and budgets are ' +
          'checked beside them.',
    '',
    '| Task | Trial | Budget | Limit | Actual | Result | Source |',
    '| ---- | ----- | ------ | ----- | ------ | ------ | ------ |',
    ...rows,
  );
  return lines;
}

/**
 * What each trial used and what it would have cost, read from its spans.
 *
 * Latency is a column only on the live axis. On replay a span's duration is
 * how fast a cassette was read, and printing it beside the recording's token
 * counts would invite reading it as the model's.
 */
function usageSection(report: SuiteReport<unknown>): string[] {
  const live = report.axes.model === 'live';
  const usage = report.usage;
  const header =
    '| Task | Trial | Source | Model calls | Input tokens | Output tokens (thinking) | ' +
    `Embedding calls | List-price equivalent |${live ? ' Model latency |' : ''}`;
  const rule =
    '| ---- | ----- | ------ | ----------- | ------------ | ------------------------ | ' +
    `--------------- | --------------------- |${live ? ' ------------- |' : ''}`;

  const row = (trial: TrialUsage): string =>
    `| \`${trial.taskId}\` | ${trial.index + 1} | ${trial.source} | ${trial.modelCalls}` +
    (trial.erroredModelCalls > 0 ? ` (${trial.erroredModelCalls} errored)` : '') +
    ` | ${number(trial.inputTokens)} | ${number(trial.outputTokens)} (${trial.reasoningTokens}) | ` +
    `${trial.embeddingCalls} (unpriced) | ${describeCost(trial.cost)} |` +
    (live
      ? ` ${trial.modelLatencyMs === null ? '—' : `${Math.round(trial.modelLatencyMs)} ms`} |`
      : '');

  const lines = ['', '### Usage', '', header, rule, ...usage.trials.map(row), ''];

  lines.push(
    usage.prices === undefined
      ? 'No price table was given, so every model is unpriced.'
      : `Costs are a list-price equivalent at ${usage.prices.tier} prices from ` +
          `${usage.prices.source} (page last updated ${usage.prices.pageLastUpdated}, read ` +
          `${usage.prices.readOn}); the free tier bills nothing. Nothing asserts them. ` +
          'Embedding calls are counted and unpriced: the API reports no usage for them.',
  );

  lines.push(
    '',
    live
      ? 'Model latency is the summed duration of the trial’s model and embedding calls: one ' +
          'sample, reported and never asserted.'
      : report.axes.model === 'replay'
        ? 'These are the recording’s figures. No model latency is reported on replay: a ' +
          'replayed span’s duration is how fast the cassette was read, not how fast the model ' +
          'answered.'
        : 'No model latency is reported off the live axis.',
  );
  return lines;
}
