import type { Grader, Score, Transcript } from '../types.js';
import type { MemoryOutcome } from '../outcome.js';

const pass = (explanation: string): Score => ({ value: 1, label: 'pass', explanation });
const fail = (explanation: string): Score => ({ value: 0, label: 'fail', explanation });

/** A deterministic grader over a transcript. */
function transcriptGrader(
  name: string,
  judge: (transcript: Transcript) => Score,
): Grader<MemoryOutcome> {
  return {
    name,
    kind: 'code',
    grade: async (transcript) => judge(transcript),
  };
}

/**
 * A deterministic grader over persisted state.
 *
 * `requires: { memory: 'live' }` is what stops it grading the no-op writers.
 * Those are reachable whenever the memory axis is unconfigured, and they return
 * `undefined` and discard their argument — a grader run against them observes
 * nothing written and cannot distinguish that from an agent that wrote nothing.
 * The harness refuses to run the suite rather than report either answer.
 */
function outcomeGrader(
  name: string,
  judge: (outcome: MemoryOutcome) => Score,
): Grader<MemoryOutcome> {
  return {
    name,
    kind: 'code',
    requires: { memory: 'live' },
    grade: async (_transcript, outcome) => judge(outcome),
  };
}

// --- Transcript assertions -------------------------------------------------
// The three that were dormant in `run-fixture-001.json`: the file declared
// them, `scripts/seed-eval-fixtures.mjs` read `expectedSeeds` and nothing else,
// and no code ever evaluated them.

export function retrievedContextMinLength(minimum: number): Grader<MemoryOutcome> {
  return transcriptGrader('retrieved_context_min_length', (transcript) => {
    const actual = transcript.retrievedContext.length;
    return actual >= minimum
      ? pass(`retrieved ${actual} candidate(s), needed ${minimum}`)
      : fail(`retrieved ${actual} candidate(s), needed ${minimum}`);
  });
}

export function outcomeMustBe(expected: Transcript['outcome']): Grader<MemoryOutcome> {
  return transcriptGrader('outcome_must_be', (transcript) =>
    transcript.outcome === expected
      ? pass(`outcome was \`${transcript.outcome}\``)
      : fail(`outcome was \`${transcript.outcome}\`, expected \`${expected}\``),
  );
}

export function tokenCountsPositive(): Grader<MemoryOutcome> {
  return transcriptGrader('token_counts_positive', (transcript) => {
    const { prompt, completion } = transcript.tokenCounts;
    return prompt > 0 && completion > 0
      ? pass(`prompt=${prompt} completion=${completion}`)
      : fail(`prompt=${prompt} completion=${completion}; both must be positive`);
  });
}

/**
 * Did at least one candidate reach `plan`'s prompt from the named retriever?
 *
 * Read on `neo4j`, this is stricter than it looks, and that is the point.
 * `rrfMerge` keeps the first candidate it sees under a key and the facade
 * passes the pgvector list first, so a fact both retrievers found is reported
 * as `pgvector`. A `neo4j` candidate is therefore one the graph alone
 * returned — a fact the seed wrote only to the graph, reached through the
 * seed linker, which is exactly what the task is asking about.
 */
export function retrievedFromSource(source: 'neo4j' | 'pgvector'): Grader<MemoryOutcome> {
  return transcriptGrader('retrieved_from_source', (transcript) => {
    const found = transcript.retrievedContext.filter((candidate) => candidate.source === source);
    const sources = transcript.retrievedContext.map((candidate) => candidate.source).join(', ');
    return found.length > 0
      ? pass(`${found.length} of ${transcript.retrievedContext.length} candidate(s) from ${source}`)
      : fail(`no candidate from ${source}; retrieved [${sources}]`);
  });
}

// --- Outcome assertions ----------------------------------------------------

/** Did `reflect` actually write the episode, under the runId the caller was given? */
export function episodicRowWritten(minimum: number): Grader<MemoryOutcome> {
  return outcomeGrader('episodic_row_written', (outcome) =>
    outcome.episodeRowsForRun >= minimum
      ? pass(`${outcome.episodeRowsForRun} episodes row(s) for run ${outcome.runId}`)
      : fail(
          `${outcome.episodeRowsForRun} episodes row(s) for run ${outcome.runId}, needed ${minimum}`,
        ),
  );
}

/**
 * Did `reflect` MERGE the entities `distill` produced?
 *
 * Keyed on the run's own extraction rather than on a count of `:Concept` nodes,
 * because `mergeEntity` records no episode on the node — a bare count cannot
 * attribute a concept to a run, and would report a pass on the seeded concepts
 * alone.
 */
export function entityMerged(minimum: number): Grader<MemoryOutcome> {
  return outcomeGrader('entity_merged', (outcome) => {
    const merged = outcome.mergedConceptIds.length;
    const extracted = outcome.extractedConceptIds.length;
    const detail = `${merged} of ${extracted} extracted concept(s) present in the graph`;
    return merged >= minimum ? pass(detail) : fail(`${detail}, needed ${minimum}`);
  });
}

/** Did the fact reach both indices, keyed on the same content hash? */
export function factsPersistedToBothIndices(minimum: number): Grader<MemoryOutcome> {
  return outcomeGrader('facts_persisted_to_both_indices', (outcome) => {
    const detail = `pgvector=${outcome.factRowsForRun} neo4j=${outcome.factNodesForRun}`;
    return outcome.factRowsForRun >= minimum && outcome.factNodesForRun >= minimum
      ? pass(detail)
      : fail(`${detail}, each needed ${minimum}`);
  });
}
