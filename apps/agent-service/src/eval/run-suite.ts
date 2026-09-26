import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  abortError,
  completedTrial,
  renderAbortJson,
  renderAbortSummary,
  renderJUnitReport,
  renderJsonReport,
  renderMarkdownSummary,
  type AbortCause,
  type Axes,
  type CompletedTrial,
  type EvalAbort,
  type ReplayProvenance,
  type SuiteReport,
  type Trial,
} from '@repo/eval-harness';
import { redactDeep } from '@repo/agent-cassette';

/**
 * Every file a run can leave behind, cleared before it starts.
 *
 * Cleared because the rule the files encode — `eval-report.json` exists only
 * if the suite completed — is only true of a directory that held nothing from
 * an earlier run. Locally `eval-results/` is reused, and an abort that left
 * yesterday's report beside today's abort file would say both things at once.
 */
export const OUTPUT_FILES = [
  'eval-report.json',
  'eval-report.xml',
  'eval-summary.md',
  'eval-abort.json',
] as const;

/**
 * How a run ended.
 *
 * `failed` and `aborted` both exit 1, because Turbo reduces any failing exit
 * code to 1 and no code the runner chooses survives it. The difference travels
 * in the output directory: three reports for `passed` and `failed`,
 * `eval-abort.json` and `eval-summary.md` for `aborted`.
 */
export type RunEnd = 'passed' | 'failed' | 'aborted';

/**
 * What the run has learned so far, filled in by the body as it goes, so an
 * abort at any point can say as much as was known when it happened.
 */
export interface RunProgress {
  axes?: Axes;
  replay?: ReplayProvenance;
  readonly completed: CompletedTrial[];
}

export interface RunAndReportOptions<TOutcome> {
  readonly outputDir: string;
  readonly suite: string;
  /**
   * The run itself. It hands every finished trial to `onTrial`, which is what
   * lets an aborted run list the trials that completed before it stopped: on a
   * live run against a daily quota, a run that dies on its last call must not
   * discard the ones it paid for.
   */
  readonly body: (
    progress: RunProgress,
    onTrial: (trial: Trial<TOutcome>) => void,
  ) => Promise<SuiteReport<TOutcome>>;
  /** Turns an error into a cause a reader can act on, when the caller can tell. */
  readonly explain?: (error: unknown, progress: RunProgress) => AbortCause | undefined;
  readonly onAbort?: (error: unknown, abort: EvalAbort) => void;
  readonly now?: () => Date;
}

/**
 * Runs the body to one of its two ends and writes the files for that end.
 *
 * Whatever the body throws — a stale cassette, an axis refusal, a request that
 * reached the model during replay, an exhausted quota, an unreachable store —
 * is an abort, and is written as one rather than escaping as a fatal log line
 * with an empty output directory.
 */
export async function runAndReport<TOutcome>(
  options: RunAndReportOptions<TOutcome>,
): Promise<RunEnd> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const progress: RunProgress = { completed: [] };

  mkdirSync(options.outputDir, { recursive: true });
  for (const file of OUTPUT_FILES) rmSync(resolve(options.outputDir, file), { force: true });

  let report: SuiteReport<TOutcome>;
  try {
    report = await options.body(progress, (trial) => {
      progress.completed.push(completedTrial(trial));
    });
  } catch (error) {
    const cause = options.explain?.(error, progress);
    const abort: EvalAbort = {
      suite: options.suite,
      startedAt,
      abortedAt: now().toISOString(),
      ...(progress.axes === undefined ? {} : { axes: progress.axes }),
      ...(progress.replay === undefined ? {} : { replay: progress.replay }),
      // Redacted here, on the side that owns the redaction: the file is
      // uploaded as a workflow artifact, and a client error is free-form text
      // written by someone else's library.
      error: redactDeep(abortError(error)) as EvalAbort['error'],
      ...(cause === undefined ? {} : { cause }),
      completedTrials: progress.completed,
    };

    writeFileSync(resolve(options.outputDir, 'eval-abort.json'), renderAbortJson(abort));
    writeFileSync(resolve(options.outputDir, 'eval-summary.md'), renderAbortSummary(abort));
    options.onAbort?.(error, abort);
    return 'aborted';
  }

  writeFileSync(resolve(options.outputDir, 'eval-report.json'), renderJsonReport(report));
  writeFileSync(resolve(options.outputDir, 'eval-report.xml'), renderJUnitReport(report));
  writeFileSync(resolve(options.outputDir, 'eval-summary.md'), renderMarkdownSummary(report));

  // A failing suite is a failing command. The gate that decides *which*
  // failures block a pull request is P1-D's; this is the local signal.
  return report.passRate < 1 ? 'failed' : 'passed';
}
