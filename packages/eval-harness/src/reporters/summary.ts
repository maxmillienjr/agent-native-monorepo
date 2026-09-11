import type { SuiteReport } from '../types.js';

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

  if (report.skipped.length > 0) {
    lines.push(
      '',
      `> **Not run on these axes — excluded from the rate above:**`,
      ...report.skipped.map(
        (skipped) => `> - \`${skipped.taskId}\` — ${skipped.problems.join('; ')}`,
      ),
    );
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

  if (report.uncalibratedGraders.length > 0) {
    lines.push(
      '',
      `> **Uncalibrated judges:** ${report.uncalibratedGraders.map((n) => `\`${n}\``).join(', ')}.`,
      '> Their true-positive and true-negative rates have not been measured against human labels.',
    );
  }

  lines.push('');
  return lines.join('\n');
}
