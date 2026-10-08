import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  GradedReportSchema,
  cassetteSetDigest,
  compareLive,
  compareReplay,
  liveReferencePath,
  liveTally,
  loadLiveReference,
  loadReplayBaseline,
  poolTallies,
  renderGateJson,
  renderGateSection,
  renderReplayBaseline,
  replayBaseline,
  replayBaselinePath,
  type Axes,
  type GateResult,
  type GradedReport,
  type ReplayBaseline,
} from '@repo/eval-harness';
import { readEpoch, writeTally } from './history.js';

/**
 * `EVAL_GATE` — what decides the exit code of `yarn eval` (P1-D).
 *
 *   replay  compare the replayed run, cell by cell, with baselines/replay.json
 *   update  rewrite baselines/replay.json from the replayed run; compare nothing
 *   live    append this run's tally to the history and compare the pooled
 *           epoch with baselines/live.json
 *
 * Unset, the runner keeps its old verdict — every trial passed — which is the
 * local signal and not a gate.
 */
export type GateMode = 'replay' | 'update' | 'live';

export function readGateMode(env: NodeJS.ProcessEnv = process.env): GateMode | undefined {
  const raw = env['EVAL_GATE'];
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'replay' || raw === 'update' || raw === 'live') return raw;
  throw new Error(`EVAL_GATE must be replay, update or live; got \`${raw}\``);
}

/**
 * Refuses a gate on an axis it cannot judge, before the Nest context exists.
 *
 * A snapshot of a live run would be a snapshot of one sample; a live tally from
 * a replayed run would pool a recording as if it were a night's evidence. Both
 * are quiet lies of the kind the axes exist to prevent, and both are cheaper to
 * refuse here than to explain in a summary.
 */
export function assertGateAxes(
  gate: GateMode | undefined,
  axes: Axes,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (gate === undefined) return;
  if ((gate === 'replay' || gate === 'update') && axes.model !== 'replay') {
    throw new Error(
      `EVAL_GATE=${gate} judges a replayed run, and this one is on model axis \`${axes.model}\`; ` +
        'set EVAL_CASSETTE_MODE=replay',
    );
  }
  if (gate === 'live' && axes.model !== 'live') {
    throw new Error(
      `EVAL_GATE=live pools live evidence, and this run is on model axis \`${axes.model}\``,
    );
  }
  if (gate === 'live' && (env['EVAL_HISTORY_DIR'] ?? '') === '') {
    throw new Error(
      'EVAL_GATE=live appends to the eval-history checkout named by EVAL_HISTORY_DIR, which is not set',
    );
  }
}

/**
 * Refuses a gate on a chat model other than the pinned one.
 *
 * `EVAL_CHAT_MODEL` exists for a hand-started run on the floating alias, which
 * is a migration comparison (P1-E). Its tally pooled into the pinned epoch
 * would average two models and call the result one, and a replay under the
 * override is already refused by the cassette player; this says so before the
 * player is reached, with the reason rather than a header mismatch.
 */
export function assertGateModel(
  gate: GateMode | undefined,
  chatModel: string,
  pinnedChatModel: string,
): void {
  if (gate === undefined || chatModel === pinnedChatModel) return;
  throw new Error(
    `EVAL_GATE=${gate} judges the pinned chat model \`${pinnedChatModel}\`, and EVAL_CHAT_MODEL ` +
      `set this run to \`${chatModel}\`. A run on another id is a comparison, not evidence for ` +
      'the gate; unset EVAL_GATE for it.',
  );
}

/** The one field of `eval-abort.json` the gate repeats: the stable cause code, when there is one. */
const AbortCodeSchema = z.object({ cause: z.object({ code: z.string() }).optional() });

export type RunOutput =
  | { readonly completed: true; readonly report: GradedReport }
  | { readonly completed: false; readonly reason: string };

/**
 * What the output directory says about the run, read from the files and never
 * from the exit code.
 *
 * The abort file first: its presence means the run did not complete whatever
 * else is there. Then the report, whose absence means the same thing.
 */
export function readRunOutput(outputDir: string): RunOutput {
  const abortPath = resolve(outputDir, 'eval-abort.json');
  if (existsSync(abortPath)) {
    const abort = AbortCodeSchema.safeParse(JSON.parse(readFileSync(abortPath, 'utf8')));
    const cause = abort.success ? abort.data.cause?.code : undefined;
    const code = cause === undefined ? '' : ` (\`${cause}\`)`;
    return { completed: false, reason: `\`eval-abort.json\` is present${code}` };
  }
  const reportPath = resolve(outputDir, 'eval-report.json');
  if (!existsSync(reportPath)) {
    return { completed: false, reason: '`eval-report.json` was not written' };
  }
  return {
    completed: true,
    report: GradedReportSchema.parse(JSON.parse(readFileSync(reportPath, 'utf8'))),
  };
}

export interface ApplyGateOptions {
  readonly mode: GateMode;
  readonly outputDir: string;
  readonly datasetDir: string;
  /** Paths in the summary are printed relative to this, so they read as repository paths. */
  readonly displayRoot: string;
  /** The committed set's digest, for `live`. Lazy, because it shells out to git. */
  readonly committedDigest: () => string;
  /** The commit this run measured, for `live`. */
  readonly gitSha: () => string;
  readonly historyDir?: string;
}

/**
 * Decides the verdict from the output directory, writes `eval-gate.json`, and
 * appends the gate's section to `eval-summary.md`.
 *
 * An error inside the gate itself — a baseline that does not parse, a history
 * checkout that is not there — is written as `aborted` with its message: there
 * is then nothing the gate compared, and saying so in the file a reader opens
 * beats a stack trace in a log they do not.
 */
export function applyGate(options: ApplyGateOptions): GateResult {
  let result: GateResult;
  try {
    result = decide(options);
  } catch (error) {
    result = {
      axis: options.mode === 'live' ? 'live' : 'replay',
      verdict: 'aborted',
      reason: `the gate could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  mkdirSync(options.outputDir, { recursive: true });
  writeFileSync(resolve(options.outputDir, 'eval-gate.json'), renderGateJson(result));
  appendFileSync(resolve(options.outputDir, 'eval-summary.md'), `\n${renderGateSection(result)}`);
  return result;
}

function decide(options: ApplyGateOptions): GateResult {
  const axis = options.mode === 'live' ? 'live' : 'replay';
  const output = readRunOutput(options.outputDir);
  if (!output.completed) return { axis, verdict: 'aborted', reason: output.reason };

  const display = (path: string): string => relative(options.displayRoot, path);
  const { report } = output;

  if (options.mode === 'update' || options.mode === 'replay') {
    const path = replayBaselinePath(options.datasetDir);
    const digest = cassetteSetDigest(options.datasetDir);

    if (options.mode === 'update') {
      const baseline = replayBaseline(report, digest);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderReplayBaseline(baseline));
      return {
        axis: 'replay',
        verdict: 'updated',
        baseline: display(path),
        cassetteDigest: digest,
        cells: baseline.cells.length,
      };
    }

    // No baseline yet is every cell `unbaselined`, not a crash: the summary
    // then lists what `update` would write.
    const baseline: ReplayBaseline = loadReplayBaseline(path) ?? {
      kind: 'replay',
      suite: report.suite,
      cassetteDigest: digest,
      recordedAt: '',
      gitSha: '',
      cells: [],
    };
    const comparison = compareReplay(report, baseline, digest);
    return {
      axis: 'replay',
      verdict: comparison.verdict,
      baseline: display(path),
      cassetteDigest: digest,
      comparison,
    };
  }

  const historyDir = options.historyDir;
  if (historyDir === undefined || historyDir === '') {
    throw new Error('EVAL_HISTORY_DIR is not set');
  }
  const tally = liveTally(report, {
    cassetteDigest: options.committedDigest(),
    gitSha: options.gitSha(),
  });
  const tallyAt = writeTally(historyDir, tally);
  const pool = poolTallies(readEpoch(historyDir, tally.suite, tally.cassetteDigest));
  const referencePath = liveReferencePath(options.datasetDir);
  const comparison = compareLive(pool, loadLiveReference(referencePath));
  return {
    axis: 'live',
    verdict: comparison.verdict,
    reference: display(referencePath),
    tally: tallyAt,
    pool,
    comparison,
  };
}
