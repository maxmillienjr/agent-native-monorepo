import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EVAL_DATASETS_DIR } from '../dataset.js';

/**
 * The retrieval-ablation dataset: a corpus written as `reflect`-shaped episodes,
 * and a labelled query set in four strata.
 *
 * It lives in its own directory rather than beside the task files because
 * `loadSuite` parses every `.json` in a dataset directory as a task, and a
 * corpus file there would make the suite throw on a Zod error.
 */
export const RETRIEVAL_ABLATION_DATASET_DIR = join(EVAL_DATASETS_DIR, 'retrieval-ablation');

// --- Corpus ------------------------------------------------------------------

export const CorpusEntitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
});

export const CorpusEpisodeSchema = z.object({
  episodeId: z.string().uuid(),
  entities: z.array(CorpusEntitySchema),
  relationships: z.array(
    z.object({
      fromId: z.string(),
      toId: z.string(),
      type: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  facts: z
    .array(
      z.object({
        /** Authoring handle, e.g. "e07-f3". Labels refer to this; the hash is computed. */
        id: z.string().min(1),
        text: z.string().min(1),
        /** The entities this fact is about. `reflect` does not record this; see "Graph shape". */
        mentions: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});
export type CorpusEpisode = z.infer<typeof CorpusEpisodeSchema>;

export const CorpusSchema = z.object({
  /** Every fact is written under this session, and every query passes it. */
  sessionId: z.string().uuid(),
  episodes: z.array(CorpusEpisodeSchema).min(1),
});
export type Corpus = z.infer<typeof CorpusSchema>;

// --- Queries -----------------------------------------------------------------

export const STRATA = ['paraphrase', 'relational', 'entity-distractor', 'no-entity'] as const;
export const StratumSchema = z.enum(STRATA);
export type Stratum = z.infer<typeof StratumSchema>;

export const LabelledQuerySchema = z.object({
  id: z.string().min(1),
  stratum: StratumSchema,
  text: z.string().min(1),
  /** Fact handles whose text answers the question. Closed set; see "Labels". */
  relevant: z.array(z.string()).min(1),
  /** The entity ids a perfect linker would return for this query. */
  goldSeeds: z.array(z.string()),
});
export type LabelledQuery = z.infer<typeof LabelledQuerySchema>;

export const QuerySetSchema = z.object({ queries: z.array(LabelledQuerySchema).min(1) });

// --- The loaded dataset --------------------------------------------------------

export interface CorpusFact {
  readonly handle: string;
  readonly text: string;
  /** sha256 of `text`, exactly as `reflect` computes it. */
  readonly contentHash: string;
  readonly episodeId: string;
  readonly mentions: readonly string[];
  /** Every entity of the fact's episode: what `reflect` links the fact to. */
  readonly episodeEntityIds: readonly string[];
}

export interface RetrievalDataset {
  readonly sessionId: string;
  readonly episodes: readonly CorpusEpisode[];
  readonly queries: readonly LabelledQuery[];
  /** Keyed on handle, in corpus order. */
  readonly facts: ReadonlyMap<string, CorpusFact>;
  /** First occurrence of each entity id, in corpus order. */
  readonly entities: ReadonlyMap<string, z.infer<typeof CorpusEntitySchema>>;
  /**
   * sha256 over the bytes of `corpus.json` followed by `queries.json`. Printed
   * in every report and pinned by the embedding file, so a label edited after
   * the first run changes a number a reader can see.
   */
  readonly sha256: string;
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The sha256 the report prints and the embedding file pins. */
export function datasetSha256(corpusBytes: Buffer, queriesBytes: Buffer): string {
  return createHash('sha256').update(corpusBytes).update(queriesBytes).digest('hex');
}

/**
 * Loads and validates a retrieval dataset.
 *
 * Throws with every problem at once rather than the first, because a dataset
 * is edited by hand and one round trip per typo is how a pre-registration
 * deadline gets missed.
 */
export function loadRetrievalDataset(
  directory: string = RETRIEVAL_ABLATION_DATASET_DIR,
): RetrievalDataset {
  const corpusBytes = readFileSync(join(directory, 'corpus.json'));
  const queriesBytes = readFileSync(join(directory, 'queries.json'));
  const dataset = buildRetrievalDataset(
    CorpusSchema.parse(JSON.parse(corpusBytes.toString('utf8'))),
    QuerySetSchema.parse(JSON.parse(queriesBytes.toString('utf8'))).queries,
    datasetSha256(corpusBytes, queriesBytes),
  );

  const problems = [...datasetProblems(dataset), ...strataProblems(dataset)];
  if (problems.length > 0) {
    throw new Error(
      `retrieval dataset in ${directory} is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return dataset;
}

/** Derives the fact and entity indexes. Does not validate; see `datasetProblems`. */
export function buildRetrievalDataset(
  corpus: Corpus,
  queries: readonly LabelledQuery[],
  sha256: string,
): RetrievalDataset {
  const facts = new Map<string, CorpusFact>();
  const entities = new Map<string, z.infer<typeof CorpusEntitySchema>>();

  for (const episode of corpus.episodes) {
    const episodeEntityIds = episode.entities.map((entity) => entity.id);
    for (const entity of episode.entities) {
      if (!entities.has(entity.id)) entities.set(entity.id, entity);
    }
    for (const fact of episode.facts) {
      if (facts.has(fact.id)) continue; // reported by datasetProblems
      facts.set(fact.id, {
        handle: fact.id,
        text: fact.text,
        contentHash: sha256Hex(fact.text),
        episodeId: episode.episodeId,
        mentions: fact.mentions,
        episodeEntityIds,
      });
    }
  }

  return {
    sessionId: corpus.sessionId,
    episodes: corpus.episodes,
    queries,
    facts,
    entities,
    sha256,
  };
}

/** Referential integrity: every id resolves, nothing is duplicated. */
export function datasetProblems(dataset: RetrievalDataset): string[] {
  const problems: string[] = [];

  const handles = new Set<string>();
  const texts = new Map<string, string>();
  const labels = new Map<string, string>();

  for (const episode of dataset.episodes) {
    const ids = new Set(episode.entities.map((entity) => entity.id));

    for (const entity of episode.entities) {
      const seen = labels.get(entity.id);
      if (seen !== undefined && seen !== entity.label) {
        problems.push(`entity ${entity.id} is labelled both "${seen}" and "${entity.label}"`);
      }
      labels.set(entity.id, entity.label);
    }

    for (const rel of episode.relationships) {
      for (const end of [rel.fromId, rel.toId]) {
        if (!ids.has(end)) {
          problems.push(
            `episode ${episode.episodeId}: relationship end ${end} is not an entity of the episode`,
          );
        }
      }
    }

    for (const fact of episode.facts) {
      if (handles.has(fact.id)) problems.push(`fact handle ${fact.id} is used twice`);
      handles.add(fact.id);

      const other = texts.get(fact.text);
      if (other !== undefined) problems.push(`facts ${other} and ${fact.id} share text`);
      texts.set(fact.text, fact.id);

      for (const mention of fact.mentions) {
        if (!ids.has(mention)) {
          problems.push(
            `fact ${fact.id} mentions ${mention}, which is not an entity of its episode`,
          );
        }
      }
    }
  }

  const queryIds = new Set<string>();
  for (const query of dataset.queries) {
    if (queryIds.has(query.id)) problems.push(`query id ${query.id} is used twice`);
    queryIds.add(query.id);

    for (const handle of query.relevant) {
      if (!dataset.facts.has(handle))
        problems.push(`query ${query.id}: relevant ${handle} is not a fact`);
    }
    if (new Set(query.relevant).size !== query.relevant.length) {
      problems.push(`query ${query.id}: a relevant handle is listed twice`);
    }
    for (const seed of query.goldSeeds) {
      if (!dataset.entities.has(seed))
        problems.push(`query ${query.id}: gold seed ${seed} is not an entity`);
    }
  }

  return problems;
}

// --- Strata ------------------------------------------------------------------

/** Undirected `RELATES_TO` adjacency over the whole corpus. */
export function adjacency(dataset: RetrievalDataset): ReadonlyMap<string, ReadonlySet<string>> {
  const adjacent = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    adjacent.get(a)!.add(b);
  };
  for (const episode of dataset.episodes) {
    for (const rel of episode.relationships) {
      link(rel.fromId, rel.toId);
      link(rel.toId, rel.fromId);
    }
  }
  return adjacent;
}

/** How many facts list the entity in their per-fact `mentions`. */
export function mentionCounts(dataset: RetrievalDataset): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const fact of dataset.facts.values()) {
    for (const mention of fact.mentions) counts.set(mention, (counts.get(mention) ?? 0) + 1);
  }
  return counts;
}

const names = (text: string, label: string): boolean =>
  text.toLowerCase().includes(label.toLowerCase());

/**
 * The first word of a label, when it is distinctive enough to count as naming
 * the entity on its own — "Kestrel" names Kestrel Review Services.
 */
function namesByFirstWord(text: string, label: string): boolean {
  const first = label.split(/\s+/)[0] ?? '';
  if (first.length < 4) return false;
  return new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/**
 * Checks each query against the construction its stratum declares.
 *
 * The strata are the part of a synthetic set most easily bent toward a result,
 * so the table in the PRD is enforced here rather than trusted:
 *
 * - `paraphrase`: every gold seed is named in the query, and every relevant
 *   fact mentions one of them.
 * - `relational`: the query names A (a gold seed); each relevant fact mentions
 *   some B, never A; A-B is a `RELATES_TO` edge; and B is not named.
 * - `entity-distractor`: the query names one gold seed that five or more facts
 *   mention, and one or two of those facts are relevant.
 * - `no-entity`: nothing in the query is capitalized, so no entity is named in
 *   capitalized form — the only form the deployed seed linker can see.
 *
 * Relevance itself is not checked, and cannot be: it is a judgement about the
 * question, and computing it from the corpus is the circularity the labels are
 * written to avoid.
 */
export function strataProblems(dataset: RetrievalDataset): string[] {
  const problems: string[] = [];
  const adjacent = adjacency(dataset);
  const counts = mentionCounts(dataset);
  const label = (id: string): string => dataset.entities.get(id)?.label ?? id;

  for (const query of dataset.queries) {
    const where = `query ${query.id} (${query.stratum})`;
    const relevant = query.relevant
      .map((handle) => dataset.facts.get(handle))
      .filter((fact): fact is CorpusFact => fact !== undefined);

    switch (query.stratum) {
      case 'paraphrase': {
        if (query.goldSeeds.length === 0) problems.push(`${where}: names no entity`);
        for (const seed of query.goldSeeds) {
          if (!names(query.text, label(seed)))
            problems.push(`${where}: does not name ${label(seed)}`);
        }
        for (const fact of relevant) {
          if (!fact.mentions.some((m) => query.goldSeeds.includes(m))) {
            problems.push(`${where}: relevant ${fact.handle} does not mention the named entity`);
          }
        }
        break;
      }
      case 'relational': {
        if (query.goldSeeds.length === 0) problems.push(`${where}: names no entity A`);
        for (const seed of query.goldSeeds) {
          if (!names(query.text, label(seed)))
            problems.push(`${where}: does not name ${label(seed)}`);
        }
        for (const fact of relevant) {
          if (fact.mentions.some((m) => query.goldSeeds.includes(m))) {
            problems.push(`${where}: relevant ${fact.handle} mentions A itself`);
          }
          const bridges = fact.mentions.filter((b) =>
            query.goldSeeds.some((a) => adjacent.get(a)?.has(b) === true),
          );
          if (bridges.length === 0) {
            problems.push(`${where}: relevant ${fact.handle} mentions no entity one edge from A`);
          }
          for (const b of bridges) {
            if (names(query.text, label(b)) || namesByFirstWord(query.text, label(b))) {
              problems.push(`${where}: names B, ${label(b)}`);
            }
          }
        }
        break;
      }
      case 'entity-distractor': {
        const [seed] = query.goldSeeds;
        if (seed === undefined || query.goldSeeds.length !== 1) {
          problems.push(`${where}: must name exactly one entity`);
          break;
        }
        if (!names(query.text, label(seed)))
          problems.push(`${where}: does not name ${label(seed)}`);
        const mentioned = counts.get(seed) ?? 0;
        if (mentioned < 5)
          problems.push(`${where}: ${seed} is mentioned by ${mentioned} facts, not 5+`);
        if (relevant.length < 1 || relevant.length > 2) {
          problems.push(`${where}: has ${relevant.length} relevant facts, not 1 or 2`);
        }
        for (const fact of relevant) {
          if (!fact.mentions.includes(seed)) {
            problems.push(`${where}: relevant ${fact.handle} does not mention ${seed}`);
          }
        }
        break;
      }
      case 'no-entity': {
        if (/[A-Z]/.test(query.text)) problems.push(`${where}: contains a capital letter`);
        break;
      }
    }
  }

  return problems;
}

// --- Graph shapes ------------------------------------------------------------

export type GraphShape = 'reflect' | 'per-fact';

export interface GraphFactSeed {
  readonly contentHash: string;
  readonly text: string;
  readonly episodeId: string;
  readonly entityIds: string[];
}

/**
 * The `:Fact` nodes and `MENTIONS` edges for one graph shape.
 *
 * `reflect` links every fact of a run to every entity of that run's extraction
 * (`reflect.node.ts`), so the `reflect` shape is what production writes and
 * every primary condition runs on it. `per-fact` links each fact only to the
 * entities it is about — a diagnostic for what the graph could do if `reflect`
 * recorded that.
 */
export function graphFacts(dataset: RetrievalDataset, shape: GraphShape): GraphFactSeed[] {
  return [...dataset.facts.values()].map((fact) => ({
    contentHash: fact.contentHash,
    text: fact.text,
    episodeId: fact.episodeId,
    entityIds: [...(shape === 'reflect' ? fact.episodeEntityIds : fact.mentions)],
  }));
}

/** Every text the embedding file must hold a vector for: facts, then queries. */
export function textsToEmbed(dataset: RetrievalDataset): string[] {
  return [
    ...[...dataset.facts.values()].map((fact) => fact.text),
    ...dataset.queries.map((q) => q.text),
  ];
}

// --- Lexical overlap ---------------------------------------------------------

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Jaccard similarity of two texts' lowercased word sets. */
export function wordJaccard(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
