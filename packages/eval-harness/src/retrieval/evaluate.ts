import { createHash } from 'node:crypto';
import { rrfMerge, type RetrievalCandidate } from '@repo/memory-core';
import { mulberry32, type PairedBootstrapResult } from '../stats/paired-bootstrap.js';
import {
  adjacency,
  STRATA,
  type GraphShape,
  type RetrievalDataset,
  type Stratum,
} from './dataset.js';
import { ndcgAtK, recallAtK, reciprocalRank } from './metrics.js';

/**
 * The ablation's arithmetic, separated from its I/O.
 *
 * The runner in `apps/agent-service` talks to the stores and hands over what
 * each reader returned; everything from there to a table is here, pure, so it
 * can be tested without a database and re-run over a saved set of lists.
 */

export const K_VALUES = [1, 3, 5, 10] as const;
export type K = (typeof K_VALUES)[number];

export type ConditionKind = 'vector' | 'graph' | 'hybrid';
export type SeedSource = 'none' | 'linker' | 'gold';

/** What one condition returned for one query. */
export interface RawQueryResult {
  readonly queryId: string;
  /** The condition's list as the reader or facade returned it, before any cut. */
  readonly ranked: readonly RetrievalCandidate[];
  readonly latencyMs: number;
  /**
   * For graph-bearing conditions: the two lists the facade fuses — pgvector at
   * `2 * topK` and the graph reader's full list — read separately, so
   * provenance never depends on `source`, which `rrfMerge` overwrites.
   */
  readonly fusionInputs?: {
    readonly vector: readonly RetrievalCandidate[];
    readonly graph: readonly RetrievalCandidate[];
  };
}

export interface RawCondition {
  readonly name: string;
  readonly table: 'primary' | 'diagnostic';
  readonly kind: ConditionKind;
  readonly seeds: SeedSource;
  readonly graphShape: GraphShape | null;
  readonly hopDepth: number | null;
  readonly results: readonly RawQueryResult[];
}

export type Labels = ReadonlyMap<string, ReadonlySet<string>>;

// --- Per-query scores ---------------------------------------------------------

export interface QueryScores {
  readonly recall: Readonly<Record<K, number>>;
  readonly ndcg: Readonly<Record<K, number>>;
  /** Reciprocal rank within the first `topK`, so its mean is MRR@topK. */
  readonly rr: number;
}

export function scoreList(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  topK: number,
): QueryScores {
  const cut = ranked.slice(0, topK);
  const byK = (f: (k: number) => number): Record<K, number> =>
    Object.fromEntries(K_VALUES.map((k) => [k, f(k)])) as Record<K, number>;
  return {
    recall: byK((k) => recallAtK(cut, relevant, k)),
    ndcg: byK((k) => ndcgAtK(cut, relevant, k)),
    rr: reciprocalRank(cut, relevant),
  };
}

export interface MetricMeans {
  readonly n: number;
  readonly recall: Readonly<Record<K, number>>;
  readonly ndcg: Readonly<Record<K, number>>;
  readonly mrr: number;
}

export function meanScores(scores: readonly QueryScores[]): MetricMeans {
  const n = scores.length;
  const mean = (f: (s: QueryScores) => number): number =>
    n === 0 ? 0 : scores.reduce((acc, s) => acc + f(s), 0) / n;
  const byK = (f: (s: QueryScores, k: K) => number): Record<K, number> =>
    Object.fromEntries(K_VALUES.map((k) => [k, mean((s) => f(s, k))])) as Record<K, number>;
  return {
    n,
    recall: byK((s, k) => s.recall[k]),
    ndcg: byK((s, k) => s.ndcg[k]),
    mrr: mean((s) => s.rr),
  };
}

/** Nearest-rank percentile; `p` in [0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

const hashes = (list: readonly RetrievalCandidate[]): string[] =>
  list.map((candidate) => candidate.contentHash ?? sha256(candidate.content));

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Code-point order, which is what Cypher's `ORDER BY` on a string is; `localeCompare` is not. */
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- Tie sensitivity -----------------------------------------------------------

/**
 * Re-sorts a graph list's tied candidates by `sha256(salt ‖ contentHash)`.
 *
 * The graph reader scores on hop distance only, so its order within one
 * distance is the order of sha256 digests — arbitrary with respect to
 * relevance — and RRF turns that order into score. Re-sorting under fixed
 * salts and re-fusing shows how much of a metric is the hash function. It
 * cannot see past the reader's `LIMIT 50`; a tie cut there is counted by
 * `limitCut`, not re-ranked.
 */
export function resortTies(
  list: readonly RetrievalCandidate[],
  salt: string,
): RetrievalCandidate[] {
  const key = (candidate: RetrievalCandidate): string =>
    sha256(`${salt}${candidate.contentHash ?? candidate.content}`);
  return [...list].sort((a, b) => b.score - a.score || byCodepoint(key(a), key(b)));
}

export const TIE_SALTS: readonly string[] = Array.from({ length: 20 }, (_, i) => `tie-salt-${i}`);

/** The condition's list under one tie order: the graph list itself, or its fusion. */
function reorderedList(
  kind: ConditionKind,
  inputs: NonNullable<RawQueryResult['fusionInputs']>,
  salt: string,
  topK: number,
): RetrievalCandidate[] {
  const graph = resortTies(inputs.graph, salt);
  return kind === 'graph' ? graph : rrfMerge([[...inputs.vector], graph], topK);
}

// --- Corpus-side reachability ---------------------------------------------------

/**
 * The facts `expandFromSeeds` should reach, and at what distance, computed
 * from the corpus rather than the store.
 *
 * Distance is the reader's: one for the `MENTIONS` hop plus the fewest
 * `RELATES_TO` hops, undirected, up to `hopDepth`. A seed that is not a
 * concept reaches nothing, which is what happens to a linker id the graph
 * does not hold. The runner compares this with what the store returned, and
 * it is the only way to count what the reader's `LIMIT 50` cut off without a
 * second query.
 */
export function reachableFacts(
  dataset: RetrievalDataset,
  shape: GraphShape,
  seeds: readonly string[],
  hopDepth: number,
): Map<string, number> {
  const adjacent = adjacency(dataset);
  const conceptDistance = new Map<string, number>();
  let frontier = seeds.filter((seed) => dataset.entities.has(seed));
  for (const seed of frontier) conceptDistance.set(seed, 0);

  for (let hop = 1; hop <= Math.min(hopDepth, 3); hop += 1) {
    const next: string[] = [];
    for (const concept of frontier) {
      for (const neighbour of adjacent.get(concept) ?? []) {
        if (conceptDistance.has(neighbour)) continue;
        conceptDistance.set(neighbour, hop);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  const reached = new Map<string, number>();
  for (const fact of dataset.facts.values()) {
    const linked = shape === 'reflect' ? fact.episodeEntityIds : fact.mentions;
    let best = Number.POSITIVE_INFINITY;
    for (const concept of linked) {
      const d = conceptDistance.get(concept);
      if (d !== undefined && d + 1 < best) best = d + 1;
    }
    if (best !== Number.POSITIVE_INFINITY) reached.set(fact.contentHash, best);
  }
  return reached;
}

export const GRAPH_READER_LIMIT = 50;

export interface LimitCut {
  /** Queries whose graph list came back at the reader's `LIMIT`. */
  readonly queriesAtLimit: number;
  /** Reachable facts the limit removed, summed over queries. */
  readonly factsCut: number;
  /** Of those, facts at the same distance as the last one kept: a tie the limit broke by hash. */
  readonly tiedAtCut: number;
  /** Queries where the store's list is exactly the corpus's reachable set, cut at the limit. */
  readonly storeAgrees: number;
  readonly queries: number;
}

export function limitCut(
  dataset: RetrievalDataset,
  condition: RawCondition,
  seedsFor: (queryId: string) => readonly string[],
): LimitCut | null {
  if (condition.graphShape === null || condition.hopDepth === null) return null;
  let queriesAtLimit = 0;
  let factsCut = 0;
  let tiedAtCut = 0;
  let storeAgrees = 0;

  for (const result of condition.results) {
    const graph = result.fusionInputs?.graph ?? [];
    const reach = reachableFacts(
      dataset,
      condition.graphShape,
      seedsFor(result.queryId),
      condition.hopDepth,
    );

    const expected = [...reach.entries()]
      .sort(([ha, da], [hb, db]) => da - db || byCodepoint(ha, hb))
      .slice(0, GRAPH_READER_LIMIT)
      .map(([hash]) => hash);
    if (JSON.stringify(expected) === JSON.stringify(hashes(graph))) storeAgrees += 1;

    if (graph.length >= GRAPH_READER_LIMIT) {
      queriesAtLimit += 1;
      factsCut += Math.max(0, reach.size - graph.length);
      const last = graph[graph.length - 1]!;
      const cutDistance = reach.get(last.contentHash ?? '');
      const kept = new Set(hashes(graph));
      for (const [hash, distance] of reach) {
        if (distance === cutDistance && !kept.has(hash)) tiedAtCut += 1;
      }
    }
  }

  return { queriesAtLimit, factsCut, tiedAtCut, storeAgrees, queries: condition.results.length };
}

// --- Summaries ------------------------------------------------------------------

export interface TieRange {
  readonly salts: number;
  readonly recall: Readonly<Record<K, readonly [number, number]>>;
  readonly ndcg: Readonly<Record<K, readonly [number, number]>>;
  readonly mrr: readonly [number, number];
}

export interface ConditionSummary {
  readonly name: string;
  readonly table: 'primary' | 'diagnostic';
  readonly kind: ConditionKind;
  readonly seeds: SeedSource;
  readonly graphShape: GraphShape | null;
  readonly hopDepth: number | null;
  readonly overall: MetricMeans;
  readonly perStratum: Readonly<Record<Stratum, MetricMeans>>;
  /** Fraction of queries on which the condition returned nothing at all. */
  readonly emptyFraction: number;
  /** Mean characters of candidate text in the first `topK` — the prompt-size proxy. */
  readonly contextChars: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  /** Min–max of each overall metric across the tie salts; graph-bearing conditions only. */
  readonly tieRange: TieRange | null;
}

export interface QueryIndex {
  readonly strata: ReadonlyMap<string, Stratum>;
}

export function queryIndex(dataset: RetrievalDataset): QueryIndex {
  return { strata: new Map(dataset.queries.map((q) => [q.id, q.stratum])) };
}

/** Per-query scores for a condition under one label set, in query order. */
export function conditionScores(
  condition: RawCondition,
  labels: Labels,
  topK: number,
): Map<string, QueryScores> {
  return new Map(
    condition.results.map((result) => [
      result.queryId,
      scoreList(hashes(result.ranked), labels.get(result.queryId) ?? new Set(), topK),
    ]),
  );
}

function byStratum(
  index: QueryIndex,
  scores: ReadonlyMap<string, QueryScores>,
): Record<Stratum, MetricMeans> {
  return Object.fromEntries(
    STRATA.map((stratum) => [
      stratum,
      meanScores([...scores].filter(([id]) => index.strata.get(id) === stratum).map(([, s]) => s)),
    ]),
  ) as Record<Stratum, MetricMeans>;
}

export function summarizeCondition(
  condition: RawCondition,
  labels: Labels,
  index: QueryIndex,
  topK: number,
): ConditionSummary {
  const scores = conditionScores(condition, labels, topK);
  const results = condition.results;
  const contextChars =
    results.length === 0
      ? 0
      : results.reduce(
          (acc, r) => acc + r.ranked.slice(0, topK).reduce((sum, c) => sum + c.content.length, 0),
          0,
        ) / results.length;

  let tieRange: TieRange | null = null;
  if (condition.kind !== 'vector' && results.every((r) => r.fusionInputs !== undefined)) {
    const perSalt = TIE_SALTS.map((salt) =>
      meanScores(
        results.map((r) =>
          scoreList(
            hashes(reorderedList(condition.kind, r.fusionInputs!, salt, topK)),
            labels.get(r.queryId) ?? new Set(),
            topK,
          ),
        ),
      ),
    );
    const range = (f: (m: MetricMeans) => number): [number, number] => {
      const values = perSalt.map(f);
      return [Math.min(...values), Math.max(...values)];
    };
    const byK = (f: (m: MetricMeans, k: K) => number): Record<K, [number, number]> =>
      Object.fromEntries(K_VALUES.map((k) => [k, range((m) => f(m, k))])) as Record<
        K,
        [number, number]
      >;
    tieRange = {
      salts: TIE_SALTS.length,
      recall: byK((m, k) => m.recall[k]),
      ndcg: byK((m, k) => m.ndcg[k]),
      mrr: range((m) => m.mrr),
    };
  }

  return {
    name: condition.name,
    table: condition.table,
    kind: condition.kind,
    seeds: condition.seeds,
    graphShape: condition.graphShape,
    hopDepth: condition.hopDepth,
    overall: meanScores([...scores.values()]),
    perStratum: byStratum(index, scores),
    emptyFraction:
      results.length === 0
        ? 0
        : results.filter((r) => r.ranked.length === 0).length / results.length,
    contextChars,
    latencyMs: {
      p50: percentile(
        results.map((r) => r.latencyMs),
        50,
      ),
      p95: percentile(
        results.map((r) => r.latencyMs),
        95,
      ),
    },
    tieRange,
  };
}

/**
 * Whether the facade's own output equals `rrfMerge` over the two lists read
 * separately. It is the premise of every in-memory re-fusion here — tie
 * sensitivity above all — so the report states it rather than assumes it.
 */
export function fusionReproduced(condition: RawCondition, topK: number): boolean {
  if (condition.kind !== 'hybrid') return true;
  return condition.results.every((r) => {
    if (r.fusionInputs === undefined) return false;
    const again = rrfMerge([[...r.fusionInputs.vector], [...r.fusionInputs.graph]], topK);
    return JSON.stringify(hashes(again)) === JSON.stringify(hashes(r.ranked));
  });
}

// --- Provenance and union -----------------------------------------------------------

export interface ProvenanceSplit {
  /** Relevant (query, fact) pairs found in the vector list only. */
  readonly vectorOnly: number;
  readonly graphOnly: number;
  readonly both: number;
  readonly neither: number;
  /** `(vectorOnly + graphOnly + both) / total`: recall of the union of the two lists. */
  readonly unionRecall: number;
  readonly total: number;
}

/**
 * For each relevant fact, which of the two fused lists held it.
 *
 * The direct test of ADR 0002's "uncorrelated failure modes": `graphOnly` is
 * what the graph found that the vector path did not. Computed over the lists
 * the facade fuses — vector at `2 * topK`, the graph's full list — because
 * that is the pool fusion chooses from; its recall is the ceiling fusion
 * could reach.
 */
export function provenance(
  condition: RawCondition,
  labels: Labels,
  index: QueryIndex,
): { overall: ProvenanceSplit; perStratum: Record<Stratum, ProvenanceSplit> } | null {
  if (!condition.results.every((r) => r.fusionInputs !== undefined)) return null;

  const tally = (ids: (id: string) => boolean): ProvenanceSplit => {
    let vectorOnly = 0;
    let graphOnly = 0;
    let both = 0;
    let neither = 0;
    for (const r of condition.results) {
      if (!ids(r.queryId)) continue;
      const v = new Set(hashes(r.fusionInputs!.vector));
      const g = new Set(hashes(r.fusionInputs!.graph));
      for (const hash of labels.get(r.queryId) ?? []) {
        if (v.has(hash) && g.has(hash)) both += 1;
        else if (v.has(hash)) vectorOnly += 1;
        else if (g.has(hash)) graphOnly += 1;
        else neither += 1;
      }
    }
    const total = vectorOnly + graphOnly + both + neither;
    return {
      vectorOnly,
      graphOnly,
      both,
      neither,
      total,
      unionRecall: total === 0 ? 0 : (total - neither) / total,
    };
  };

  return {
    overall: tally(() => true),
    perStratum: Object.fromEntries(
      STRATA.map((stratum) => [stratum, tally((id) => index.strata.get(id) === stratum)]),
    ) as Record<Stratum, ProvenanceSplit>,
  };
}

// --- The decision rule -----------------------------------------------------------------

export const DECISION_MARGIN = 0.05;

export type RuleOutcome = 'earns-its-keep' | 'does-not' | 'inconclusive';

/**
 * The rule P2-B pre-registered, on a paired bootstrap of `hybrid − best`
 * Recall@10:
 *
 * - earns its keep if the point difference is at least the margin and the
 *   interval's lower bound is above 0;
 * - does not if the interval's upper bound is below the margin;
 * - otherwise inconclusive — never rounded toward either side.
 */
export function applyDecisionRule(
  interval: PairedBootstrapResult,
  margin = DECISION_MARGIN,
): RuleOutcome {
  if (interval.mean >= margin && interval.lower > 0) return 'earns-its-keep';
  if (interval.upper < margin) return 'does-not';
  return 'inconclusive';
}

// --- Pooling ------------------------------------------------------------------------

export interface PoolCandidate {
  readonly id: string;
  readonly text: string;
}
export interface PoolQuery {
  readonly id: string;
  readonly text: string;
  readonly candidates: readonly PoolCandidate[];
}
export interface PoolKeyEntry {
  readonly candidateId: string;
  readonly queryId: string;
  readonly handle: string;
}

/**
 * TREC-style pooling: the first `topK` of every ranked condition, minus what is
 * already labelled relevant, shuffled and stripped of where it came from.
 *
 * Queries get opaque ids because a query id names its stratum, and the
 * adjudicator sees neither conditions nor strata. The shuffle is seeded, so the
 * pool is a function of the run, and the key that maps a candidate back to its
 * query and fact is written separately and never given to the adjudicator.
 */
export function buildPool(
  dataset: RetrievalDataset,
  conditions: readonly RawCondition[],
  topK: number,
  seed = 0x9001,
): { queries: PoolQuery[]; key: PoolKeyEntry[] } {
  const handleByHash = new Map([...dataset.facts.values()].map((f) => [f.contentHash, f]));
  const random = mulberry32(seed);
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };

  const perQuery = dataset.queries.map((query) => {
    const labelled = new Set(query.relevant);
    const pooled = new Set<string>();
    for (const condition of conditions) {
      const result = condition.results.find((r) => r.queryId === query.id);
      for (const hash of hashes(result?.ranked.slice(0, topK) ?? [])) {
        const fact = handleByHash.get(hash);
        if (fact !== undefined && !labelled.has(fact.handle)) pooled.add(fact.handle);
      }
    }
    return { query, handles: shuffle([...pooled].sort()) };
  });

  const queries: PoolQuery[] = [];
  const key: PoolKeyEntry[] = [];
  let next = 1;
  shuffle(perQuery).forEach(({ query, handles }, i) => {
    const candidates = handles.map((handle) => {
      const id = `c${String(next++).padStart(4, '0')}`;
      key.push({ candidateId: id, queryId: query.id, handle });
      return { id, text: dataset.facts.get(handle)!.text };
    });
    if (candidates.length > 0) {
      queries.push({ id: `q${String(i + 1).padStart(3, '0')}`, text: query.text, candidates });
    }
  });

  return { queries, key };
}
