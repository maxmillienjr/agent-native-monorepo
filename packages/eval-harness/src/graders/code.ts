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
// them, the nightly seed script (since deleted) read `expectedSeeds` and
// nothing else, and no code ever evaluated them.

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
 * Did `reflect` write at least `minimum` `semantic_facts` rows under this run's id?
 *
 * The one semantic write `reflect` makes (P2-E), and the positive control ADR
 * 0011 names: the agent still promotes what the user said. Keyed on the row's
 * `episode_id`, so a seeded fact never counts. A fact whose text an earlier run
 * already wrote lands on that run's row, since the upsert keys on the content
 * hash, so a run that only repeats known facts reads zero here.
 */
export function semanticFactWritten(minimum: number): Grader<MemoryOutcome> {
  return outcomeGrader('semantic_fact_written', (outcome) => {
    const detail = `${outcome.factRowsForRun} semantic_facts row(s) for run ${outcome.runId}`;
    return outcome.factRowsForRun >= minimum ? pass(detail) : fail(`${detail}, needed ${minimum}`);
  });
}
