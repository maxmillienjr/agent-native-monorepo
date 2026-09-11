import type { SuiteReport } from '../types.js';

/**
 * The full report, including every transcript and every captured outcome.
 *
 * It is the only reporter that loses nothing: JUnit collapses trials into
 * test cases and the Markdown summary collapses them into rates. A disputed
 * result is re-read from here rather than re-run, which for a suite whose every
 * trial is a live model call is the difference between an argument and a bill.
 *
 * Losing nothing includes the tasks that did not run: `skipped` names each one
 * and what it needed, so the denominator behind `passRate` is reconstructable
 * from the file rather than inferred from the length of `tasks`.
 */
export function renderJsonReport(report: SuiteReport<unknown>): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
