/**
 * A seeded paired percentile bootstrap (Efron and Tibshirani, 1993).
 *
 * Paired because two retrieval conditions are run over the same queries, and
 * the variance that matters is in the per-query difference, not in either
 * system's scores alone: a hard query is hard for both. Resampling queries and
 * averaging the differences keeps that pairing.
 *
 * Seeded because a confidence interval that moves between two runs over the
 * same numbers cannot be pre-registered against. The generator is mulberry32 —
 * small, fast, and fully determined by a 32-bit seed — rather than
 * `Math.random`, which cannot be seeded at all.
 *
 * It lives in `stats/` rather than `retrieval/` because nothing here knows what
 * a query is. P1-D's gate compares a run against a baseline and needs the same
 * interval.
 */

export interface PairedBootstrapOptions {
  /** Default 10,000. */
  readonly resamples?: number;
  /** Default 0x5eed. Any 32-bit integer; the same seed gives the same interval. */
  readonly seed?: number;
  /** Two-sided coverage. Default 0.95. */
  readonly confidence?: number;
}

export interface PairedBootstrapResult {
  /** Number of paired observations. */
  readonly n: number;
  /** Mean of `a[i] - b[i]`: the point estimate. */
  readonly mean: number;
  /** Sample standard deviation of the per-pair differences (n - 1 denominator). */
  readonly sd: number;
  /** Lower bound of the percentile interval. */
  readonly lower: number;
  /** Upper bound of the percentile interval. */
  readonly upper: number;
  readonly resamples: number;
  readonly seed: number;
  readonly confidence: number;
}

export const DEFAULT_BOOTSTRAP_SEED = 0x5eed;

/** mulberry32: a 32-bit state, a uniform float in [0, 1) per call. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The interval on the mean of `a[i] - b[i]`.
 *
 * Throws on unpaired input rather than truncating to the shorter array: two
 * lists of different lengths are not a pairing, and silently dropping queries
 * from one side is how a comparison ends up over different query sets.
 */
export function pairedBootstrap(
  a: readonly number[],
  b: readonly number[],
  options: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  if (a.length !== b.length) {
    throw new Error(`paired bootstrap needs equal-length inputs; got ${a.length} and ${b.length}`);
  }
  if (a.length === 0) throw new Error('paired bootstrap needs at least one pair');

  const resamples = options.resamples ?? 10_000;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new Error(`resamples must be a positive integer; got ${resamples}`);
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error(`confidence must be in (0, 1); got ${confidence}`);
  }

  const n = a.length;
  const diffs = a.map((value, i) => value - b[i]!);
  const mean = sum(diffs) / n;
  const sd = n < 2 ? 0 : Math.sqrt(diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (n - 1));

  const random = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += diffs[Math.floor(random() * n)]!;
    means[r] = total / n;
  }
  means.sort();

  const alpha = 1 - confidence;
  const lowerIndex = Math.floor((alpha / 2) * resamples);
  const upperIndex = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1);

  return {
    n,
    mean,
    sd,
    lower: means[lowerIndex]!,
    upper: means[upperIndex]!,
    resamples,
    seed,
    confidence,
  };
}

/**
 * How many pairs a normal-approximation interval of this `sd` would need for
 * its half-width to fall below `distance`.
 *
 * It answers "what sample size would resolve an inconclusive result": pass the
 * distance between the point estimate and the boundary it failed to clear.
 * `null` when the distance is zero — no sample size separates a point from
 * itself.
 */
export function pairsToResolve(sd: number, distance: number, z = 1.959964): number | null {
  if (distance === 0) return null;
  if (sd === 0) return 1;
  return Math.ceil(((z * sd) / Math.abs(distance)) ** 2);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
