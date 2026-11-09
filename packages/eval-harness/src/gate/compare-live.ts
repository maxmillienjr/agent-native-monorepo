import { pairedBootstrap, type PairedBootstrapOptions } from '../stats/paired-bootstrap.js';
import { stratifiedBootstrap } from '../stats/stratified-bootstrap.js';
import type { LivePool, LiveReference } from './baseline.js';

/**
 * The live comparison: statistical, conditional, and usually
 * `insufficient-evidence` (P1-D).
 *
 * The statistic is `Δ = (1/K) Σ_t (p̂_cand,t − p̂_ref,t)`, where `p̂` is the
 * fraction of a task's trials in which every grader passed — the trial-level
 * `passed` the harness already computes. Only this one number is gated; the
 * per-grader tallies are diagnostic, because gating eleven graders separately
 * would need a multiple-comparisons correction for no decision the trial-level
 * rate does not already make.
 *
 * The rule was pre-registered in the PRD before any live number existed, and
 * the constants below are that rule. Changing one is a change to the PRD's
 * successor, never an edit to a verdict already issued.
 */

/** The margin on Δ. Decided at review, 2026-09-26. */
export const LIVE_DELTA = 0.2;

/**
 * The task count from which tasks are resampled as a sample (Huang, 2018:
 * cluster-bootstrap standard errors behave from 20 clusters, mixed at 10).
 */
export const TASKS_RANDOM_FROM = 20;

export type LiveVerdict = 'held' | 'regressed' | 'insufficient-evidence' | 'incomparable';

/**
 * - `tasks-fixed`: trials resampled within each task, each arm on its own. The
 *   interval is about these K tasks and nothing beyond them.
 * - `tasks-random`: per-task differences resampled, P2-B's `pairedBootstrap`.
 *   The interval is about tasks like these, which is Miller's question.
 */
export type LiveRegime = 'tasks-fixed' | 'tasks-random';

/**
 * The rule of three (Hanley and Lippman-Hand, 1983): zero failures in n trials
 * bounds the failure rate at about 3/n with 95% confidence. Below `⌈3/δ⌉` an
 * all-pass stratum has a `[0, 0]` interval that says nothing, so neither
 * `held` nor `regressed` is issued there.
 */
export function trialFloor(delta: number): number {
  return Math.ceil(3 / delta - 1e-9);
}

/**
 * The `tasks-random` floor, pre-registered by P1-H as P1-D's successor for that
 * regime before any live prior-auth number existed.
 *
 * `tasks-random` resamples per-task differences, not trials, so its degenerate
 * case is every task's difference being equal, and the rule of three then
 * applies across tasks: at K ≥ `TASKS_RANDOM_FROM` no changed task bounds the
 * share of changed tasks at 3/K ≤ 0.15, below δ. The regime threshold already
 * does what `⌈3/δ⌉` does for `tasks-fixed`; what is left is that a task's rate
 * is not a single coin, which two trials in each arm meet.
 */
export const TASKS_RANDOM_TRIAL_FLOOR = 2;

/** The regime a comparison over `taskCount` tasks runs in. */
export function liveRegime(taskCount: number): LiveRegime {
  return taskCount >= TASKS_RANDOM_FROM ? 'tasks-random' : 'tasks-fixed';
}

/** Trials each task needs in each arm before `held` or `regressed` is issued. */
export function regimeFloor(regime: LiveRegime, delta: number): number {
  return regime === 'tasks-random' ? TASKS_RANDOM_TRIAL_FLOOR : trialFloor(delta);
}

export interface LiveTaskArms {
  readonly task: string;
  readonly candidate: { readonly passed: number; readonly trials: number };
  readonly reference: { readonly passed: number; readonly trials: number };
  /** Trials this task still needs in each arm before the floor is met. */
  readonly needs: { readonly candidate: number; readonly reference: number };
}

export interface LiveComparison {
  readonly verdict: LiveVerdict;
  /** Why, in a sentence a job summary can print. */
  readonly reason: string;
  readonly delta: number;
  /** Trials per task per arm the regime needs: `⌈3/δ⌉` in `tasks-fixed`, 2 in `tasks-random`. */
  readonly floor: number;
  /** Absent only when the arms could not be compared at all. */
  readonly regime?: LiveRegime;
  readonly estimate?: number;
  readonly lower?: number;
  readonly upper?: number;
  readonly resamples: number;
  readonly seed?: number;
  readonly confidence: number;
  readonly tasks: readonly LiveTaskArms[];
}

export interface CompareLiveOptions extends PairedBootstrapOptions {
  readonly delta?: number;
}

/**
 * Compares a pooled epoch with the committed reference.
 *
 * - `regressed`: the floor is met, `Δ ≤ −δ`, and the upper bound is below 0.
 * - `held`: the floor is met and the lower bound is above `−δ`.
 * - `insufficient-evidence`: everything else, including every case where the
 *   floor is not met. It is never displayed as passing.
 * - `incomparable`: no reference, another suite, or another task set.
 */
export function compareLive(
  candidate: LivePool,
  reference: LiveReference | undefined,
  options: CompareLiveOptions = {},
): LiveComparison {
  const delta = options.delta ?? LIVE_DELTA;
  const resamples = options.resamples ?? 10_000;
  const confidence = options.confidence ?? 0.95;

  // The floor follows the regime, and the regime follows the number of tasks
  // the two arms name between them, so it is known before either is compared.
  const candidateTasks = Object.keys(candidate.tasks).sort();
  const arms = (ref: LivePool | undefined): { floor: number; tasks: LiveTaskArms[] } => {
    const ids = [...new Set([...candidateTasks, ...Object.keys(ref?.tasks ?? {})])].sort();
    const floor = regimeFloor(liveRegime(ids.length), delta);
    return {
      floor,
      tasks: ids.map((task) => {
        const c = candidate.tasks[task]?.trials ?? [];
        const r = ref?.tasks[task]?.trials ?? [];
        return {
          task,
          candidate: { passed: c.filter(Boolean).length, trials: c.length },
          reference: { passed: r.filter(Boolean).length, trials: r.length },
          needs: {
            candidate: Math.max(0, floor - c.length),
            reference: Math.max(0, floor - r.length),
          },
        };
      }),
    };
  };
  const base = { delta, resamples, confidence };

  if (reference === undefined) {
    return {
      ...base,
      verdict: 'incomparable',
      reason: 'there is no committed live reference yet; promote one with `yarn eval:promote-live`',
      ...arms(undefined),
    };
  }
  if (reference.suite !== candidate.suite) {
    return {
      ...base,
      verdict: 'incomparable',
      reason: `the reference is suite \`${reference.suite}\` and this is \`${candidate.suite}\``,
      ...arms(reference),
    };
  }
  const referenceTasks = Object.keys(reference.tasks).sort();
  const same =
    referenceTasks.length === candidateTasks.length &&
    referenceTasks.every((task, i) => task === candidateTasks[i]);
  const { floor, tasks } = arms(reference);
  if (!same || tasks.some((t) => t.candidate.trials === 0 || t.reference.trials === 0)) {
    return {
      ...base,
      verdict: 'incomparable',
      reason:
        `the task sets differ: reference [${referenceTasks.join(', ')}], ` +
        `candidate [${candidateTasks.join(', ')}]`,
      floor,
      tasks,
    };
  }

  const asNumbers = (pool: LivePool): Record<string, number[]> =>
    Object.fromEntries(
      Object.entries(pool.tasks).map(([task, { trials }]) => [task, trials.map(Number)]),
    );

  const regime = liveRegime(tasks.length);
  const bootstrap = {
    resamples,
    confidence,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };
  const interval =
    regime === 'tasks-random'
      ? (() => {
          const rate = (arm: 'candidate' | 'reference'): number[] =>
            tasks.map((t) => t[arm].passed / t[arm].trials);
          const result = pairedBootstrap(rate('candidate'), rate('reference'), bootstrap);
          return {
            estimate: result.mean,
            lower: result.lower,
            upper: result.upper,
            seed: result.seed,
          };
        })()
      : (() => {
          const result = stratifiedBootstrap(asNumbers(candidate), asNumbers(reference), bootstrap);
          return {
            estimate: result.estimate,
            lower: result.lower,
            upper: result.upper,
            seed: result.seed,
          };
        })();

  const short = tasks.filter((t) => t.needs.candidate > 0 || t.needs.reference > 0);
  const floorMet = short.length === 0;

  let verdict: LiveVerdict;
  let reason: string;
  if (!floorMet) {
    verdict = 'insufficient-evidence';
    reason =
      regime === 'tasks-random'
        ? `${short.length} of ${tasks.length} task(s) have fewer than ${floor} trials in an arm ` +
          "(the `tasks-random` floor), and below that a task's rate is a single coin"
        : `${short.length} of ${tasks.length} task(s) have fewer than ${floor} trials in an arm ` +
          `(⌈3/δ⌉ at δ = ${delta}), and below that an all-pass sample cannot rule out a rate under ${1 - delta}`;
  } else if (interval.estimate <= -delta && interval.upper < 0) {
    verdict = 'regressed';
    reason = `Δ = ${fmt(interval.estimate)} is at or below −δ and the interval excludes 0`;
  } else if (interval.lower > -delta) {
    verdict = 'held';
    reason = `the interval's lower bound ${fmt(interval.lower)} is above −δ = ${fmt(-delta)}`;
  } else {
    verdict = 'insufficient-evidence';
    reason =
      `the interval [${fmt(interval.lower)}, ${fmt(interval.upper)}] reaches below −δ without ` +
      'showing a drop of δ; more trials narrow it';
  }

  return { ...base, floor, verdict, reason, regime, ...interval, tasks };
}

const fmt = (value: number): string => (Math.round(value * 1000) / 1000).toString();
