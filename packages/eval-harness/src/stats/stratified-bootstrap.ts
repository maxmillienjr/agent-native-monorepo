import {
  DEFAULT_BOOTSTRAP_SEED,
  mulberry32,
  type PairedBootstrapOptions,
} from './paired-bootstrap.js';

/**
 * A seeded two-sample stratified percentile bootstrap (Efron and Tibshirani,
 * 1993, ch. 8).
 *
 * The estimator is the mean, over strata, of the difference between the two
 * arms' stratum means: `Δ = (1/K) Σ_t (mean(a_t) − mean(b_t))`. Each resample
 * redraws every stratum of each arm independently, with replacement and at its
 * own size, and recomputes Δ.
 *
 * Not paired. On the live model axis, trial 3 of a candidate run and trial 3 of
 * the reference share nothing — the provider makes no reproducibility promise
 * to pair them on — so the only thing both arms share is the stratum (the
 * task). Resampling within strata keeps each task's weight fixed at `1/K`,
 * which is what makes the interval about *these K tasks* and nothing beyond
 * them. Once tasks can be treated as a sample, `pairedBootstrap` over per-task
 * differences answers the wider question; P1-D switches at K = 20.
 *
 * The options, the generator and the seed default are `pairedBootstrap`'s, so
 * the two regimes a gate moves between differ in what they resample and in
 * nothing else.
 */

export interface StratifiedBootstrapResult {
  /** Number of strata, K. */
  readonly strata: number;
  /** Δ on the observed data: the point estimate. */
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly resamples: number;
  readonly seed: number;
  readonly confidence: number;
}

export type StratifiedSample = Readonly<Record<string, readonly number[]>>;

/**
 * The interval on `Δ` between arm `a` and arm `b`.
 *
 * Throws when the two arms do not have the same strata, or a stratum is empty
 * in either: a difference over mismatched task sets is not the statistic, and
 * dropping a stratum to make it computable would change what `1/K` weighs.
 * Strata are visited in sorted order, so the same input and seed give the same
 * interval whatever order the caller built the records in.
 */
export function stratifiedBootstrap(
  a: StratifiedSample,
  b: StratifiedSample,
  options: PairedBootstrapOptions = {},
): StratifiedBootstrapResult {
  const strata = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  if (strata.length === 0) throw new Error('stratified bootstrap needs at least one stratum');
  if (strata.length !== other.length || strata.some((key, i) => key !== other[i])) {
    throw new Error(
      `stratified bootstrap needs the same strata in both arms; got [${strata.join(', ')}] ` +
        `and [${other.join(', ')}]`,
    );
  }
  for (const key of strata) {
    if (a[key]!.length === 0 || b[key]!.length === 0) {
      throw new Error(`stratum \`${key}\` is empty in one arm`);
    }
  }

  const resamples = options.resamples ?? 10_000;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new Error(`resamples must be a positive integer; got ${resamples}`);
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error(`confidence must be in (0, 1); got ${confidence}`);
  }

  const k = strata.length;
  const arms = strata.map((key) => [a[key]!, b[key]!] as const);
  const estimate = arms.reduce((acc, [x, y]) => acc + mean(x) - mean(y), 0) / k;

  const random = mulberry32(seed);
  const draw = (values: readonly number[]): number => {
    let total = 0;
    for (let i = 0; i < values.length; i += 1) {
      total += values[Math.floor(random() * values.length)]!;
    }
    return total / values.length;
  };

  const deltas = new Float64Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let total = 0;
    for (const [x, y] of arms) total += draw(x) - draw(y);
    deltas[r] = total / k;
  }
  deltas.sort();

  // The same indices `pairedBootstrap` reads, so a regime switch never moves
  // an interval by an off-by-one in the percentile.
  const alpha = 1 - confidence;
  const lowerIndex = Math.floor((alpha / 2) * resamples);
  const upperIndex = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1);

  return {
    strata: k,
    estimate,
    lower: deltas[lowerIndex]!,
    upper: deltas[upperIndex]!,
    resamples,
    seed,
    confidence,
  };
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}
