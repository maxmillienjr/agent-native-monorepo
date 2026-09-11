import type { SuiteReport, Trial } from '../types.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function failureMessage(trial: Trial<unknown>): string {
  return trial.results
    .filter((result) => result.score.label === 'fail')
    .map((result) => `${result.grader}: ${result.score.explanation ?? 'no explanation'}`)
    .join('; ');
}

/**
 * JUnit XML for CI test-report ingestion.
 *
 * One test case per trial rather than per grader, because the unit a reader
 * acts on is "trial 3 of this task failed" — the grader names are in the
 * failure message. A task's suite therefore has exactly k cases, and the
 * failure count read against k is `pass^k` spelled out.
 *
 * A skipped task gets a suite of its own holding one `<skipped/>` case. Not a
 * pass, which would claim something that was never run, and not an absence,
 * which would let a task drop out of a CI test report without a trace.
 */
export function renderJUnitReport(report: SuiteReport<unknown>): string {
  const totalTrials = report.tasks.reduce((sum, task) => sum + task.trials.length, 0);
  const totalFailures = report.tasks.reduce(
    (sum, task) => sum + task.trials.filter((trial) => !trial.passed).length,
    0,
  );

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(report.suite)}" tests="${totalTrials + report.skipped.length}"` +
      ` failures="${totalFailures}" skipped="${report.skipped.length}">`,
  ];

  for (const task of report.tasks) {
    const failures = task.trials.filter((trial) => !trial.passed).length;
    lines.push(
      `  <testsuite name="${escapeXml(task.taskId)}" tests="${task.trials.length}" failures="${failures}">`,
    );
    lines.push(
      `    <properties>`,
      `      <property name="pass@k" value="${task.passAtK}"/>`,
      `      <property name="pass^k" value="${task.passHatK}"/>`,
      `      <property name="model_axis" value="${report.axes.model}"/>`,
      `      <property name="memory_axis" value="${report.axes.memory}"/>`,
      `    </properties>`,
    );

    for (const trial of task.trials) {
      const name = `${task.taskId} trial ${trial.index + 1}`;
      if (trial.passed) {
        lines.push(`    <testcase name="${escapeXml(name)}"/>`);
      } else {
        lines.push(
          `    <testcase name="${escapeXml(name)}">`,
          `      <failure message="${escapeXml(failureMessage(trial))}"/>`,
          `    </testcase>`,
        );
      }
    }

    lines.push('  </testsuite>');
  }

  for (const skipped of report.skipped) {
    lines.push(
      `  <testsuite name="${escapeXml(skipped.taskId)}" tests="1" failures="0" skipped="1">`,
      `    <testcase name="${escapeXml(`${skipped.taskId} (not run)`)}">`,
      `      <skipped message="${escapeXml(skipped.problems.join('; '))}"/>`,
      `    </testcase>`,
      '  </testsuite>',
    );
  }

  lines.push('</testsuites>', '');
  return lines.join('\n');
}
