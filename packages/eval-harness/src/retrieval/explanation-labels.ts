import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  RETRIEVAL_ABLATION_DATASET_DIR,
  sha256Hex,
  type CorpusFact,
  type RetrievalDataset,
} from './dataset.js';

/**
 * P2-D's labels: for every (query, pre-registered relevant fact) pair of P2-B's
 * dataset, the concept paths that correctly explain why the fact answers the
 * question, and for each relational query the strings a correct answer must
 * contain.
 *
 * Gold paths are derived from the strata construction, not judged. P2-B's
 * loader already enforces that a relational query names A, that its answer
 * fact mentions some B and never A, and that A–B is a `RELATES_TO` edge; the
 * gold path is every `[A, type, B]` that satisfies that. The extractor is
 * therefore an oracle — the corpus that seeds the graph is the corpus the gold
 * comes from — and the ADR says so.
 *
 * The file is committed before any explainer or runner code exists, and
 * `deriveGoldPaths` is what produced it. A unit test holds the committed file
 * equal to the derivation, so an edit to either is visible.
 */
export const EXPLANATION_LABELS_FILE = 'explanation-labels.json';

export const ConceptPathSchema = z.object({
  /** Concept ids from a question concept to a concept the fact mentions. Length 1 = the fact mentions it. */
  concepts: z.array(z.string()).min(1),
  /** `RELATES_TO` types between consecutive concepts; length = concepts.length - 1. */
  edgeTypes: z.array(z.string()),
});
export type GoldPath = z.infer<typeof ConceptPathSchema>;

export const ExplanationPairSchema = z.object({
  queryId: z.string(),
  /** A pre-registered `relevant` handle of the query. */
  factHandle: z.string(),
  /** Empty means the correct explanation is none. */
  gold: z.array(ConceptPathSchema),
});
export type ExplanationPair = z.infer<typeof ExplanationPairSchema>;

export const ExplanationLabelsSchema = z.object({
  /** sha256 of corpus.json + queries.json, as P2-B prints it; the loader refuses a mismatch. */
  datasetSha256: z.string().length(64),
  pairs: z.array(ExplanationPairSchema),
  /** Relational query id -> alternatives; an answer containing any one of them is correct. */
  answerKeys: z.record(z.string(), z.array(z.string()).min(1)),
});
export type ExplanationLabels = z.infer<typeof ExplanationLabelsSchema>;

// --- Derivation ----------------------------------------------------------------

/** Every `RELATES_TO` type between two concepts, in either direction, sorted. */
function edgeTypesBetween(dataset: RetrievalDataset): (a: string, b: string) => string[] {
  const types = new Map<string, Set<string>>();
  const key = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const episode of dataset.episodes) {
    for (const rel of episode.relationships) {
      const k = key(rel.fromId, rel.toId);
      if (!types.has(k)) types.set(k, new Set());
      types.get(k)!.add(rel.type);
    }
  }
  return (a, b) => [...(types.get(key(a, b)) ?? [])].sort();
}

/**
 * The gold paths for every (query, relevant fact) pair, in query order.
 *
 * - `relational`: `[A, type, B]` for each gold seed A, each B the fact mentions,
 *   and each `RELATES_TO` type between them.
 * - `paraphrase` and `entity-distractor`: `[A]` for each gold seed the fact
 *   mentions.
 * - `no-entity`: none. The question names no concept, so nothing connects it.
 *
 * Paths are sorted by their joined id sequence, so the derivation is a pure
 * function of the dataset's contents and the committed file can be compared
 * with it byte for byte.
 */
export function deriveGoldPaths(dataset: RetrievalDataset): ExplanationPair[] {
  const between = edgeTypesBetween(dataset);
  const pairs: ExplanationPair[] = [];

  for (const query of dataset.queries) {
    for (const handle of query.relevant) {
      const fact = dataset.facts.get(handle)!;
      const gold: GoldPath[] = [];

      switch (query.stratum) {
        case 'relational':
          for (const a of query.goldSeeds) {
            for (const b of fact.mentions) {
              for (const type of between(a, b)) gold.push({ concepts: [a, b], edgeTypes: [type] });
            }
          }
          break;
        case 'paraphrase':
        case 'entity-distractor':
          for (const a of query.goldSeeds) {
            if (fact.mentions.includes(a)) gold.push({ concepts: [a], edgeTypes: [] });
          }
          break;
        case 'no-entity':
          break;
      }

      gold.sort((x, y) => pathKey(x).localeCompare(pathKey(y)));
      pairs.push({ queryId: query.id, factHandle: handle, gold });
    }
  }

  return pairs;
}

/**
 * The total-order key of a path: its concepts and edge types interleaved.
 * Two paths over the same concepts with different edge types are different
 * paths, so the types are part of the key.
 */
export function pathKey(path: {
  concepts: readonly string[];
  edgeTypes: readonly string[];
}): string {
  const parts: string[] = [];
  path.concepts.forEach((concept, i) => {
    parts.push(concept);
    if (i < path.edgeTypes.length) parts.push(path.edgeTypes[i]!);
  });
  return parts.join('|');
}

// --- Answer keys -----------------------------------------------------------------

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
};
const NUMBER_WORD = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'g');

/**
 * The form an answer key, a fact and a model's answer are compared in:
 * lowercased, whitespace collapsed, digit-group commas dropped, and the number
 * words up to ninety written as digits.
 *
 * The PRD asks for two things that conflict on their face: alternatives "for
 * the forms a number can take", and a loader check that every alternative
 * occurs in the fact's text. "5 business days" does not occur in "five
 * business days". Comparing in this form satisfies both: the check holds for
 * each form, and a grader that normalizes the answer the same way accepts
 * either spelling.
 */
export function normalizeAnswerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(NUMBER_WORD, (word) => NUMBER_WORDS[word]!)
    .trim();
}

/** Whether an answer contains any of the key's alternatives, both normalized. */
export function answerKeyPresent(answer: string, alternatives: readonly string[]): boolean {
  const normalized = normalizeAnswerText(answer);
  return alternatives.some((alt) => normalized.includes(normalizeAnswerText(alt)));
}

// --- Loading and validation -------------------------------------------------------

/**
 * Everything wrong with a label set against its dataset, all at once.
 *
 * - The dataset hash matches, so a label written against an earlier corpus
 *   cannot be read against a later one.
 * - Every pair names a query and one of its pre-registered relevant facts, and
 *   every such pair is labelled exactly once.
 * - Every gold concept is a corpus entity, and every gold edge is a corpus
 *   `RELATES_TO` edge of that type, in either direction.
 * - Each relational pair has at least one gold path.
 * - Every relational query has an answer key, and each alternative occurs in
 *   the relevant fact's text and not in the query's, both normalized.
 */
export function explanationLabelProblems(
  dataset: RetrievalDataset,
  labels: ExplanationLabels,
): string[] {
  const problems: string[] = [];
  const between = edgeTypesBetween(dataset);
  const queries = new Map(dataset.queries.map((q) => [q.id, q]));

  if (labels.datasetSha256 !== dataset.sha256) {
    problems.push(
      `labels were written against dataset ${labels.datasetSha256}, not ${dataset.sha256}`,
    );
  }

  const seen = new Set<string>();
  for (const pair of labels.pairs) {
    const where = `pair ${pair.queryId}/${pair.factHandle}`;
    const query = queries.get(pair.queryId);
    if (query === undefined) {
      problems.push(`${where}: no such query`);
      continue;
    }
    if (!query.relevant.includes(pair.factHandle)) {
      problems.push(`${where}: ${pair.factHandle} is not a pre-registered relevant fact`);
    }
    const id = `${pair.queryId}\u0000${pair.factHandle}`;
    if (seen.has(id)) problems.push(`${where}: labelled twice`);
    seen.add(id);

    for (const path of pair.gold) {
      if (path.edgeTypes.length !== path.concepts.length - 1) {
        problems.push(`${where}: path ${pathKey(path)} has the wrong number of edge types`);
      }
      for (const concept of path.concepts) {
        if (!dataset.entities.has(concept))
          problems.push(`${where}: ${concept} is not a corpus entity`);
      }
      path.edgeTypes.forEach((type, i) => {
        const a = path.concepts[i]!;
        const b = path.concepts[i + 1];
        if (b !== undefined && !between(a, b).includes(type)) {
          problems.push(`${where}: no ${type} edge between ${a} and ${b} in the corpus`);
        }
      });
    }

    if (query.stratum === 'relational' && pair.gold.length === 0) {
      problems.push(`${where}: a relational pair has no gold path`);
    }
  }

  for (const query of dataset.queries) {
    for (const handle of query.relevant) {
      if (!seen.has(`${query.id}\u0000${handle}`)) {
        problems.push(`pair ${query.id}/${handle}: not labelled`);
      }
    }
  }

  for (const query of dataset.queries) {
    if (query.stratum !== 'relational') continue;
    const key = labels.answerKeys[query.id];
    if (key === undefined) {
      problems.push(`answer key ${query.id}: missing`);
      continue;
    }
    const facts = query.relevant
      .map((handle) => dataset.facts.get(handle))
      .filter((fact): fact is CorpusFact => fact !== undefined);
    const queryText = normalizeAnswerText(query.text);
    for (const alternative of key) {
      const alt = normalizeAnswerText(alternative);
      if (!facts.some((fact) => normalizeAnswerText(fact.text).includes(alt))) {
        problems.push(`answer key ${query.id}: "${alternative}" is not in the relevant fact`);
      }
      if (queryText.includes(alt)) {
        problems.push(`answer key ${query.id}: "${alternative}" is in the query itself`);
      }
    }
  }
  for (const id of Object.keys(labels.answerKeys)) {
    if (queries.get(id)?.stratum !== 'relational') {
      problems.push(`answer key ${id}: not a relational query`);
    }
  }

  return problems;
}

/** Loads the committed labels and throws with every problem if they do not fit the dataset. */
export function loadExplanationLabels(
  dataset: RetrievalDataset,
  directory: string = RETRIEVAL_ABLATION_DATASET_DIR,
): { labels: ExplanationLabels; sha256: string } {
  const bytes = readFileSync(join(directory, EXPLANATION_LABELS_FILE));
  const labels = ExplanationLabelsSchema.parse(JSON.parse(bytes.toString('utf8')));
  const problems = explanationLabelProblems(dataset, labels);
  if (problems.length > 0) {
    throw new Error(
      `explanation labels in ${directory} are invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return { labels, sha256: sha256Hex(bytes) };
}
