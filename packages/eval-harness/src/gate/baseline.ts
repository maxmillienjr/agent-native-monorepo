import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { cassettesDir } from '../dataset.js';

/**
 * What the gate compares, and the files it compares against (P1-D).
 *
 * Two axes, two kinds of file. A replayed run is deterministic, so its baseline
 * is a snapshot of every grader result and the comparison is exact. A live run
 * is a sample, so what is kept is a tally of pass/fail per trial, pooled across
 * nights and compared with a statistic. Both are committed or appended and read
 * back through the schemas below, because each is a file some other run wrote.
 */

// --- What a completed run produced -----------------------------------------

/**
 * The part of `eval-report.json` the gate reads.
 *
 * A subset rather than `SuiteReport`, because the gate reads the report off
 * disk — it is a file another process wrote — and because everything it does
 * not read (transcripts, outcomes, explanations) is exactly what it must not
 * compare. `readonly` so a `SuiteReport` in memory is accepted as-is.
 */
export const GradedReportSchema = z
  .object({
    suite: z.string(),
    startedAt: z.string(),
    axes: z.object({ model: z.string(), memory: z.string() }),
    replay: z.object({ recordedAt: z.string(), gitSha: z.string() }).optional(),
    /** P2-C: the GenAI semantic-conventions commit the run's spans and events follow. */
    genAiSemconvCommit: z.string().optional(),
    tasks: z
      .array(
        z.object({
          taskId: z.string(),
          trials: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                passed: z.boolean(),
                results: z
                  .array(
                    z.object({
                      grader: z.string(),
                      score: z.object({ label: z.enum(['pass', 'fail']), value: z.number() }),
                    }),
                  )
                  .readonly(),
              }),
            )
            .readonly(),
        }),
      )
      .readonly(),
  })
  .readonly();
export type GradedReport = z.infer<typeof GradedReportSchema>;

// --- The replay snapshot ---------------------------------------------------

/**
 * One grader's result on one trial of one task.
 *
 * The explanation is not here. It is prose for a human and it carries the run
 * id (`2 episodes row(s) for run <uuid>`), which differs on every run; leaving
 * it out makes the comparison exact without a list of fields to mask that
 * someone has to keep up to date.
 */
export const ReplayCellSchema = z.object({
  task: z.string(),
  trial: z.number().int().nonnegative(),
  grader: z.string(),
  label: z.enum(['pass', 'fail']),
  value: z.number(),
});
export type ReplayCell = z.infer<typeof ReplayCellSchema>;

export const ReplayBaselineSchema = z.object({
  kind: z.literal('replay'),
  suite: z.string(),
  /** sha256 over the committed cassette files, sorted by path. Ties the snapshot to its recording. */
  cassetteDigest: z.string(),
  recordedAt: z.string(),
  gitSha: z.string(),
  /**
   * P2-C's semantic-conventions commit, from `SuiteReport.genAiSemconvCommit`. Provenance
   * only: it is not compared, because a conventions bump renames span attributes and moves
   * no grader result, and it is here so that two baselines on either side of one can be
   * told apart.
   */
  semconvCommit: z.string().optional(),
  cells: z.array(ReplayCellSchema),
});
export type ReplayBaseline = z.infer<typeof ReplayBaselineSchema>;

/** Where a dataset keeps its baselines. A subdirectory, for the reason `cassettesDir` is one. */
export function baselinesDir(datasetDir: string): string {
  return join(datasetDir, 'baselines');
}

export function replayBaselinePath(datasetDir: string): string {
  return join(baselinesDir(datasetDir), 'replay.json');
}

export function liveReferencePath(datasetDir: string): string {
  return join(baselinesDir(datasetDir), 'live.json');
}

const cellKey = (cell: Pick<ReplayCell, 'task' | 'trial' | 'grader'>): string =>
  `${cell.task}\u0000${String(cell.trial).padStart(6, '0')}\u0000${cell.grader}`;

export function compareCells(
  a: Pick<ReplayCell, 'task' | 'trial' | 'grader'>,
  b: Pick<ReplayCell, 'task' | 'trial' | 'grader'>,
): number {
  const x = cellKey(a);
  const y = cellKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Every cell a completed run produced, sorted by task, trial and grader. */
export function replayCells(report: GradedReport): ReplayCell[] {
  const cells: ReplayCell[] = [];
  for (const task of report.tasks) {
    for (const trial of task.trials) {
      for (const result of trial.results) {
        cells.push({
          task: task.taskId,
          trial: trial.index,
          grader: result.grader,
          label: result.score.label,
          value: result.score.value,
        });
      }
    }
  }
  return cells.sort(compareCells);
}

/** The baseline `EVAL_GATE=update` writes for a completed replayed run. */
export function replayBaseline(report: GradedReport, cassetteDigest: string): ReplayBaseline {
  if (report.axes.model !== 'replay' || report.replay === undefined) {
    throw new Error(
      `a replay baseline is written from a replayed run; this one ran on model axis ` +
        `\`${report.axes.model}\``,
    );
  }
  return {
    kind: 'replay',
    suite: report.suite,
    cassetteDigest,
    recordedAt: report.replay.recordedAt,
    gitSha: report.replay.gitSha,
    ...(report.genAiSemconvCommit === undefined
      ? {}
      : { semconvCommit: report.genAiSemconvCommit }),
    cells: replayCells(report),
  };
}

/**
 * The baseline as a file: provenance first, then one cell per line.
 *
 * One per line so that a pull request's diff of the file reads as the list of
 * behaviour it changes — a flipped label is one `-` and one `+` naming the
 * task, the trial and the grader. `JSON.stringify(_, null, 2)` would spread each
 * cell over seven lines and bury the change.
 */
export function renderReplayBaseline(baseline: ReplayBaseline): string {
  const head: [string, unknown][] = [
    ['kind', baseline.kind],
    ['suite', baseline.suite],
    ['cassetteDigest', baseline.cassetteDigest],
    ['recordedAt', baseline.recordedAt],
    ['gitSha', baseline.gitSha],
    ...(baseline.semconvCommit === undefined
      ? []
      : ([['semconvCommit', baseline.semconvCommit]] as [string, unknown][])),
  ];
  const cells = [...baseline.cells].sort(compareCells).map((cell) =>
    JSON.stringify({
      task: cell.task,
      trial: cell.trial,
      grader: cell.grader,
      label: cell.label,
      value: cell.value,
    }),
  );
  return [
    '{',
    ...head.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`),
    '  "cells": [',
    cells.map((cell) => `    ${cell}`).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

/** `undefined` when the file does not exist; a thrown Zod error when it is not a baseline. */
export function loadReplayBaseline(path: string): ReplayBaseline | undefined {
  if (!existsSync(path)) return undefined;
  return ReplayBaselineSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

// --- The cassette set's identity -------------------------------------------

export interface DigestInput {
  /** Relative to the cassettes directory. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * sha256 over the files, sorted by path, each as `path NUL bytes NUL`.
 *
 * Over whole files, so any re-record starts a new value — including one whose
 * decisions came out identical. That wastes live evidence (a new epoch pools
 * from zero) but can never put two prompts in one epoch, which is the error
 * that would matter.
 */
export function digestFiles(files: readonly DigestInput[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update('\u0000');
    hash.update(file.bytes);
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/** The digest of the cassette set in a dataset directory as it is on disk. */
export function cassetteSetDigest(datasetDir: string): string {
  const dir = cassettesDir(datasetDir);
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
  return digestFiles(names.map((path) => ({ path, bytes: readFileSync(join(dir, path)) })));
}

// --- Live evidence ---------------------------------------------------------

/**
 * One nightly live run, as appended to the `eval-history` branch.
 *
 * `trials` holds one boolean per trial — did every grader pass — which is the
 * only thing the statistic reads. The per-grader arrays are there to diagnose a
 * `regressed` verdict, and are never tested.
 */
export const LiveTallySchema = z.object({
  kind: z.literal('live-tally'),
  suite: z.string(),
  cassetteDigest: z.string(),
  gitSha: z.string(),
  startedAt: z.string(),
  tasks: z.record(
    z.object({ trials: z.array(z.boolean()), graders: z.record(z.array(z.boolean())) }),
  ),
});
export type LiveTally = z.infer<typeof LiveTallySchema>;

export const LiveRunSchema = z.object({ gitSha: z.string(), startedAt: z.string() });
export type LiveRun = z.infer<typeof LiveRunSchema>;

/**
 * Nights of one epoch pooled: every trial of every run, per task, with the list
 * of runs that produced them.
 */
export const LivePoolSchema = z.object({
  suite: z.string(),
  cassetteDigest: z.string(),
  runs: z.array(LiveRunSchema),
  tasks: z.record(z.object({ trials: z.array(z.boolean()) })),
});
export type LivePool = z.infer<typeof LivePoolSchema>;

/**
 * The committed reference a live pool is compared with: one past epoch's pool,
 * promoted from `eval-history` by a reviewed pull request.
 *
 * Committed rather than read from the branch, and never "the previous epoch" by
 * default: that default would let a regressed epoch become the reference for
 * the next one, laundering the regression one re-record later.
 */
export const LiveReferenceSchema = LivePoolSchema.extend({ kind: z.literal('live-reference') });
export type LiveReference = z.infer<typeof LiveReferenceSchema>;

export function loadLiveReference(path: string): LiveReference | undefined {
  if (!existsSync(path)) return undefined;
  return LiveReferenceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The tally a completed live run appends. */
export function liveTally(
  report: GradedReport,
  provenance: { readonly cassetteDigest: string; readonly gitSha: string },
): LiveTally {
  if (report.axes.model !== 'live') {
    throw new Error(
      `a live tally is written from a live run; this one ran on model axis \`${report.axes.model}\``,
    );
  }
  const tasks: LiveTally['tasks'] = {};
  for (const task of report.tasks) {
    if (task.trials.length === 0) continue;
    const trials = [...task.trials].sort((a, b) => a.index - b.index);
    const graders: Record<string, boolean[]> = {};
    for (const trial of trials) {
      for (const result of trial.results) {
        (graders[result.grader] ??= []).push(result.score.label === 'pass');
      }
    }
    tasks[task.taskId] = { trials: trials.map((trial) => trial.passed), graders };
  }
  return {
    kind: 'live-tally',
    suite: report.suite,
    cassetteDigest: provenance.cassetteDigest,
    gitSha: provenance.gitSha,
    startedAt: report.startedAt,
    tasks,
  };
}

/**
 * Where a tally lives on the history branch, relative to its root:
 * `live/<suite>/<digest:12>/<startedAt>-<sha:7>.json`.
 *
 * The epoch is a directory, so pooling one is a directory listing. The colons
 * are taken out of the timestamp because a checkout on Windows cannot hold
 * them; what is left still sorts by time.
 */
export function tallyPath(
  tally: Pick<LiveTally, 'suite' | 'cassetteDigest' | 'gitSha' | 'startedAt'>,
): string {
  return posix.join(
    epochDir(tally.suite, tally.cassetteDigest),
    `${tally.startedAt.replace(/:/g, '')}-${tally.gitSha.slice(0, 7)}.json`,
  );
}

export function epochDir(suite: string, cassetteDigest: string): string {
  return posix.join('live', suite, cassetteDigest.slice(0, 12));
}

/**
 * Pools one epoch's tallies, in the order the runs started.
 *
 * Refuses a mix of suites or digests rather than pooling it: a pool over two
 * cassette sets is a pool over two prompts, which is the thing the epoch exists
 * to rule out.
 */
export function poolTallies(tallies: readonly LiveTally[]): LivePool {
  const first = tallies[0];
  if (first === undefined) throw new Error('there are no tallies to pool');
  for (const tally of tallies) {
    if (tally.suite !== first.suite || tally.cassetteDigest !== first.cassetteDigest) {
      throw new Error(
        `cannot pool across suites or epochs: ${first.suite}@${first.cassetteDigest.slice(0, 12)} ` +
          `and ${tally.suite}@${tally.cassetteDigest.slice(0, 12)}`,
      );
    }
  }
  const ordered = [...tallies].sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );
  const tasks: LivePool['tasks'] = {};
  for (const tally of ordered) {
    for (const [taskId, task] of Object.entries(tally.tasks)) {
      (tasks[taskId] ??= { trials: [] }).trials.push(...task.trials);
    }
  }
  return {
    suite: first.suite,
    cassetteDigest: first.cassetteDigest,
    runs: ordered.map((tally) => ({ gitSha: tally.gitSha, startedAt: tally.startedAt })),
    tasks,
  };
}
