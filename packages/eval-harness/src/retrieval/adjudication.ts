import { join } from 'node:path';
import { z } from 'zod';
import type { RetrievalDataset } from './dataset.js';
import type { Labels, PoolKeyEntry, PoolQuery } from './evaluate.js';

/**
 * Blind adjudication of the pooled candidates, as files.
 *
 * Three files, and who may see which is the point:
 *
 * - `pool-candidates.json` — each query's text and its unlabelled pooled
 *   candidates, shuffled, with no condition, stratum, source or fact handle.
 *   This is all the adjudicator is given.
 * - `pool-key.json` — candidate id to query id and fact handle. Never given to
 *   the adjudicator.
 * - `decisions.json` — the adjudicator's verdict on every candidate, and who
 *   the adjudicator was.
 *
 * Adjudication can only add labels. The pool holds unlabelled candidates, so a
 * pre-registered label is never put in front of the adjudicator to remove, and
 * the pre-registered set stays the one the decision rule is applied to.
 */
export const ADJUDICATION_DIR = 'adjudication';

export function adjudicationPaths(datasetDir: string): {
  candidates: string;
  key: string;
  decisions: string;
} {
  const dir = join(datasetDir, ADJUDICATION_DIR);
  return {
    candidates: join(dir, 'pool-candidates.json'),
    key: join(dir, 'pool-key.json'),
    decisions: join(dir, 'decisions.json'),
  };
}

export const POOL_INSTRUCTIONS =
  'For each query, judge every candidate independently: is it relevant, meaning its text answers ' +
  'the question as asked, in whole or in part? Judge the text alone. Do not guess at which system ' +
  'retrieved it; that information has been removed. Record one decision per candidate id.';

export const PoolCandidatesFileSchema = z.object({
  instructions: z.string(),
  queries: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      candidates: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
    }),
  ),
});

export const PoolKeyFileSchema = z.object({
  datasetSha256: z.string().length(64),
  key: z.array(z.object({ candidateId: z.string(), queryId: z.string(), handle: z.string() })),
});

export const DecisionsFileSchema = z.object({
  adjudicator: z.object({
    /** The model or person, named, so a reader can discount a model's judgement. */
    name: z.string().min(1),
    kind: z.enum(['model', 'person']),
  }),
  decisions: z.array(
    z.object({ id: z.string(), relevant: z.boolean(), note: z.string().optional() }),
  ),
});
export type DecisionsFile = z.infer<typeof DecisionsFileSchema>;

export function renderPoolFiles(
  datasetSha256: string,
  pool: { queries: readonly PoolQuery[]; key: readonly PoolKeyEntry[] },
): { candidates: string; key: string } {
  return {
    candidates: `${JSON.stringify({ instructions: POOL_INSTRUCTIONS, queries: pool.queries }, null, 2)}\n`,
    key: `${JSON.stringify({ datasetSha256, key: pool.key }, null, 2)}\n`,
  };
}

/**
 * The adjudicated label set: every pre-registered label, plus every pooled
 * candidate judged relevant.
 *
 * Refuses a key from another dataset, a decision for a candidate the key does
 * not hold, a candidate decided twice, and a candidate left undecided: a
 * partial adjudication read as complete would under-count missing labels in
 * exactly the queries nobody got to.
 */
export function adjudicatedLabels(
  dataset: RetrievalDataset,
  rawKey: unknown,
  rawDecisions: unknown,
): {
  labels: Labels;
  judgedRelevant: number;
  candidates: number;
  adjudicator: DecisionsFile['adjudicator'];
} {
  const key = PoolKeyFileSchema.parse(rawKey);
  const decisions = DecisionsFileSchema.parse(rawDecisions);

  if (key.datasetSha256 !== dataset.sha256) {
    throw new Error(`the pool key belongs to dataset ${key.datasetSha256}, not ${dataset.sha256}`);
  }

  const byId = new Map(key.key.map((entry) => [entry.candidateId, entry]));
  const decided = new Map<string, boolean>();
  const problems: string[] = [];
  for (const decision of decisions.decisions) {
    if (!byId.has(decision.id)) problems.push(`decision for unknown candidate ${decision.id}`);
    if (decided.has(decision.id)) problems.push(`candidate ${decision.id} decided twice`);
    decided.set(decision.id, decision.relevant);
  }
  const undecided = [...byId.keys()].filter((id) => !decided.has(id));
  if (undecided.length > 0)
    problems.push(`${undecided.length} candidate(s) undecided, first ${undecided[0]}`);
  if (problems.length > 0)
    throw new Error(`adjudication is not usable:\n  - ${problems.join('\n  - ')}`);

  const hashOf = (handle: string): string => {
    const fact = dataset.facts.get(handle);
    if (fact === undefined) throw new Error(`the pool key names ${handle}, which is not a fact`);
    return fact.contentHash;
  };

  const labels = new Map<string, Set<string>>(
    dataset.queries.map((q) => [q.id, new Set(q.relevant.map(hashOf))]),
  );
  let judgedRelevant = 0;
  for (const [id, relevant] of decided) {
    if (!relevant) continue;
    const entry = byId.get(id)!;
    labels.get(entry.queryId)?.add(hashOf(entry.handle));
    judgedRelevant += 1;
  }

  return { labels, judgedRelevant, candidates: byId.size, adjudicator: decisions.adjudicator };
}
