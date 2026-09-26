/**
 * Rank metrics for one ranked list against one set of relevant ids.
 *
 * Pure, and deliberately not `Grader`s. A grader turns one agent trial into a
 * pass or a fail; a retrieval benchmark has no trial and no threshold, and its
 * unit is a ranked list per query, averaged. P1-A promised these "on the
 * `Grader` interface", and the interface does not fit them.
 *
 * Every function reads position only. Two candidates the retriever scored
 * identically are still at two positions, so a metric over a list with tied
 * scores is a function of however the ties were broken — which is why the
 * ablation reports a tie-sensitivity range beside every rank metric.
 *
 * A list that repeats an id counts it once, at its first position. Neither
 * reader can return a duplicate, but a metric that rewarded one would credit a
 * retriever for returning the same fact twice.
 */

/** The first `k` distinct ids, in order. */
function topK(ranked: readonly string[], k: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ranked) {
    if (out.length >= k) break;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The fraction of the relevant set found in the first `k` positions.
 *
 * An empty relevant set scores 0 rather than NaN: a query nothing answers
 * cannot be recalled, and a NaN averaged into a mean poisons it silently.
 */
export function recallAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0 || k <= 0) return 0;
  const hits = topK(ranked, k).filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

/**
 * `1 / rank` of the first relevant id, 1-indexed; 0 when none is present.
 *
 * Averaged over queries this is MRR at whatever depth the list was cut to, so
 * the caller cuts every condition to the same depth before calling it.
 */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const distinct = topK(ranked, Number.POSITIVE_INFINITY);
  const index = distinct.findIndex((id) => relevant.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Binary-gain nDCG at `k` with a log2 discount (Järvelin and Kekäläinen, 2002).
 *
 * The ideal ranking puts every relevant id first, so IDCG sums over
 * `min(k, |relevant|)` positions. With no relevant ids there is no ideal to
 * normalise by, and the score is 0 for the same reason `recallAtK`'s is.
 */
export function ndcgAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0 || k <= 0) return 0;

  const discount = (position: number): number => 1 / Math.log2(position + 2);

  let dcg = 0;
  topK(ranked, k).forEach((id, position) => {
    if (relevant.has(id)) dcg += discount(position);
  });

  let idcg = 0;
  for (let position = 0; position < Math.min(k, relevant.size); position += 1) {
    idcg += discount(position);
  }

  return dcg / idcg;
}
