import type { Driver } from 'neo4j-driver';
import { getTracer } from '@repo/telemetry';
import { GEN_AI, GEN_AI_OPERATION } from '@repo/telemetry/genai';

const tracer = getTracer('memory-core');

/** `gen_ai.operation.name` on this file's spans, as on the reader's. */
const SEARCH = {
  attributes: { [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.SEARCH_MEMORY },
};

/** At most this many paths are returned per fact. */
export const MAX_PATHS_PER_FACT = 3;
/** At most this many `RELATES_TO` hops from a question concept to a concept the fact mentions. */
export const MAX_EXPLANATION_HOPS = 2;

/**
 * The session an explanation is confined to. Required, and there is no
 * `crossSession` form: an explanation returns the concept ids and edge types
 * it crosses, so anything outside the session would be shown, not just used.
 */
export interface ExplanationScope {
  readonly sessionId: string;
}

/** A path from a question concept to a concept a fact mentions. */
export interface ConceptPath {
  /** Concept ids, question concept first. Length 1: the fact mentions a question concept. */
  readonly concepts: readonly string[];
  /** `RELATES_TO` types between consecutive concepts; length = concepts.length - 1. */
  readonly edgeTypes: readonly string[];
}

export interface Neo4jExplainer {
  /**
   * For each fact the session owns, the shortest paths from the question's
   * concepts to the concepts the fact mentions. Keyed on content hash; a fact
   * the session does not own has no entry.
   */
  explain(
    questionConceptIds: readonly string[],
    factContentHashes: readonly string[],
    scope: ExplanationScope,
  ): Promise<ReadonlyMap<string, readonly ConceptPath[]>>;

  /** The ids of the session's concepts whose label the text names. See `matchConceptLabels`. */
  linkQuestionConcepts(text: string, scope: ExplanationScope): Promise<string[]>;
}

/** The total-order key of a path: concepts and edge types interleaved. */
export function conceptPathKey(path: ConceptPath): string {
  const parts: string[] = [];
  path.concepts.forEach((concept, i) => {
    parts.push(concept);
    if (i < path.edgeTypes.length) parts.push(path.edgeTypes[i]!);
  });
  return parts.join('|');
}

/** Orders paths by length, then by key, so the order is total. */
export function compareConceptPaths(a: ConceptPath, b: ConceptPath): number {
  const byLength = a.edgeTypes.length - b.edgeTypes.length;
  if (byLength !== 0) return byLength;
  const ka = conceptPathKey(a);
  const kb = conceptPathKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** One traversal the explain query returned: a fact, a concept it mentions, and a path to it. */
export interface ExplanationRow {
  readonly contentHash: string;
  /** Null when the fact has no in-session `MENTIONS` edge. */
  readonly mentioned: string | null;
  /** Null when no question concept reaches the mentioned concept. */
  readonly path: ConceptPath | null;
}

/**
 * Turns the query's rows into each fact's explanation.
 *
 * Per concept the fact mentions, only the shortest paths survive — from any
 * question concept, so a longer route to a concept that a shorter one already
 * reaches is not an explanation of it. Paths over the same concepts and types
 * in either direction are one path. The survivors are ordered by length and
 * key, and cut at `MAX_PATHS_PER_FACT`.
 *
 * Pure, and separate from the Cypher, so the ordering and the cut are unit
 * tested without a store.
 */
export function assembleExplanations(
  factContentHashes: readonly string[],
  rows: readonly ExplanationRow[],
): Map<string, ConceptPath[]> {
  const byFact = new Map<string, Map<string, ConceptPath[]>>();
  for (const row of rows) {
    if (!byFact.has(row.contentHash)) byFact.set(row.contentHash, new Map());
    if (row.mentioned === null || row.path === null) continue;
    const byConcept = byFact.get(row.contentHash)!;
    if (!byConcept.has(row.mentioned)) byConcept.set(row.mentioned, []);
    byConcept.get(row.mentioned)!.push(row.path);
  }

  const explanations = new Map<string, ConceptPath[]>();
  for (const hash of factContentHashes) {
    const byConcept = byFact.get(hash);
    if (byConcept === undefined) continue; // not a fact this session owns
    const unique = new Map<string, ConceptPath>();
    for (const paths of byConcept.values()) {
      const shortest = Math.min(...paths.map((p) => p.edgeTypes.length));
      for (const path of paths) {
        if (path.edgeTypes.length !== shortest) continue;
        const forward = conceptPathKey(path);
        const backward = conceptPathKey({
          concepts: [...path.concepts].reverse(),
          edgeTypes: [...path.edgeTypes].reverse(),
        });
        if (!unique.has(forward) && !unique.has(backward)) unique.set(forward, path);
      }
    }
    explanations.set(
      hash,
      [...unique.values()].sort(compareConceptPaths).slice(0, MAX_PATHS_PER_FACT),
    );
  }
  return explanations;
}

/**
 * The ids of the concepts whose label occurs in the text: whole words,
 * regardless of case, longest match first, and no two matches overlapping —
 * so "Harbor Mutual Silver" links the plan and not the payer "Harbor Mutual".
 *
 * A word boundary is any character that is not a letter or a digit, which
 * lets a label like "E11.9" match before a question mark. Returned in text
 * order. No model call: the linker is string matching over labels the
 * session's own writes put in the graph.
 */
export function matchConceptLabels(
  text: string,
  concepts: readonly { readonly id: string; readonly label: string }[],
): string[] {
  const haystack = text.toLowerCase();
  const isWordChar = (ch: string | undefined): boolean =>
    ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

  const matches: { start: number; end: number; id: string }[] = [];
  for (const concept of concepts) {
    const needle = concept.label.toLowerCase().trim();
    if (needle === '') continue;
    let from = 0;
    for (;;) {
      const start = haystack.indexOf(needle, from);
      if (start === -1) break;
      const end = start + needle.length;
      if (!isWordChar(haystack[start - 1]) && !isWordChar(haystack[end])) {
        matches.push({ start, end, id: concept.id });
      }
      from = start + 1;
    }
  }

  // Longest first; among equals, the earlier one, then the smaller id, so
  // two concepts with one label resolve the same way on every run.
  matches.sort(
    (a, b) =>
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const taken: { start: number; end: number; id: string }[] = [];
  for (const match of matches) {
    if (taken.every((t) => match.end <= t.start || match.start >= t.end)) taken.push(match);
  }

  const ids: string[] = [];
  for (const match of taken.sort((a, b) => a.start - b.start)) {
    if (!ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}

/**
 * Concept paths from a question to the facts retrieved for it: the graph's
 * one candidate role since ADR 0009, measured by P2-D.
 *
 * Every part of the read is scoped to one session (P2-D's M1, extended to
 * edges): the facts are the session's own, and the `MENTIONS` and
 * `RELATES_TO` edges crossed are ones it wrote. It returns ids and edge
 * types, never labels or descriptions, because `mergeEntity` makes those
 * last-writer-wins across sessions. An id on an edge the session wrote was
 * written by the session.
 *
 * Not on any request path. Whether it goes on one is P2-E's, on P2-D's ADR.
 */
export class CypherNeo4jExplainer implements Neo4jExplainer {
  constructor(private readonly driver: Driver) {}

  async explain(
    questionConceptIds: readonly string[],
    factContentHashes: readonly string[],
    scope: ExplanationScope,
  ): Promise<ReadonlyMap<string, readonly ConceptPath[]>> {
    return tracer.startActiveSpan('memory.neo4j.explain', SEARCH, async (span) => {
      try {
        span.setAttribute('seedEntityCount', questionConceptIds.length);
        span.setAttribute('factCount', factContentHashes.length);

        const session = this.driver.session();
        try {
          // `*0..2` is undirected and lets a fact that mentions a question
          // concept explain itself at length 0. The scope is on the fact,
          // on its MENTIONS edges and on every RELATES_TO edge of the path;
          // the shortest-path cut is done by `assembleExplanations`, so the
          // same rule is unit tested without a store.
          const result = await session.run(
            `UNWIND $hashes AS hash
             MATCH (f:Fact {contentHash: hash})
             WHERE f.sessionId = $sessionId
             OPTIONAL MATCH (f)-[m:MENTIONS]->(c:Concept)
             WHERE m.sessionId = $sessionId
             OPTIONAL MATCH p = (q:Concept)-[:RELATES_TO*0..${MAX_EXPLANATION_HOPS}]-(c)
             WHERE q.id IN $questionIds
               AND all(r IN relationships(p) WHERE r.sessionId = $sessionId)
             RETURN f.contentHash AS hash,
                    c.id AS mentioned,
                    CASE WHEN p IS NULL THEN null ELSE [n IN nodes(p) | n.id] END AS concepts,
                    CASE WHEN p IS NULL THEN null ELSE [r IN relationships(p) | r.type] END AS edgeTypes`,
            {
              hashes: [...factContentHashes],
              questionIds: [...questionConceptIds],
              sessionId: scope.sessionId,
            },
          );

          const rows: ExplanationRow[] = result.records.map((record) => {
            const concepts = record.get('concepts') as string[] | null;
            const edgeTypes = record.get('edgeTypes') as string[] | null;
            return {
              contentHash: record.get('hash') as string,
              mentioned: record.get('mentioned') as string | null,
              path: concepts === null || edgeTypes === null ? null : { concepts, edgeTypes },
            };
          });

          const explanations = assembleExplanations(factContentHashes, rows);
          let paths = 0;
          for (const list of explanations.values()) paths += list.length;
          span.setAttribute('resultCount', paths);
          return explanations;
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }

  async linkQuestionConcepts(text: string, scope: ExplanationScope): Promise<string[]> {
    return tracer.startActiveSpan('memory.neo4j.linkQuestionConcepts', SEARCH, async (span) => {
      try {
        const session = this.driver.session();
        try {
          // A concept is the session's when an edge the session wrote touches
          // it. The label is read from the global node, which another
          // session's mergeEntity can rename: that can change which concept
          // is chosen, never what `explain` returns for it.
          const result = await session.run(
            `MATCH (c:Concept)
             WHERE EXISTS { (c)-[r:RELATES_TO|MENTIONS]-() WHERE r.sessionId = $sessionId }
             RETURN c.id AS id, c.label AS label
             ORDER BY id`,
            { sessionId: scope.sessionId },
          );
          const concepts = result.records
            .map((record) => ({
              id: record.get('id') as string,
              label: record.get('label') as string | null,
            }))
            .filter((c): c is { id: string; label: string } => c.label !== null);
          span.setAttribute('conceptCount', concepts.length);

          const ids = matchConceptLabels(text, concepts);
          span.setAttribute('resultCount', ids.length);
          return ids;
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }
}
