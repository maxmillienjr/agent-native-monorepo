/**
 * The environment state after a trial, for this system.
 *
 * An agent can produce a plausible answer while writing nothing, and only an
 * assertion against persisted state catches that. These are counts read from
 * Postgres, Neo4j and pgvector *after* the run, through the read surface in
 * `packages/memory-core` — the harness never opens a pool of its own. Reviewer
 * checklist rule 4 forbids database calls outside `memory-core`, and the reason
 * is not stylistic: the nightly seed script, since deleted, recorded that
 * hand-rolled SQL is how the eval fixtures ended up in a table shaped
 * differently from production's. A grader with its own `SELECT` drifts the same way, and a
 * grader that drifts reports a false negative on the one signal this package
 * exists to produce.
 *
 * Capturing a snapshot rather than handing graders a live connection also means
 * the numbers a grader judged are in the JSON report, so a disputed result can
 * be re-read instead of re-run.
 */
export interface MemoryOutcome {
  readonly runId: string;
  readonly sessionId: string;
  /** `episodes` rows carrying this run's id. */
  readonly episodeRowsForRun: number;
  /** `semantic_facts` rows whose `episode_id` is this run's id. */
  readonly factRowsForRun: number;
  /** `(:Fact {episodeId})` nodes for this run. */
  readonly factNodesForRun: number;
  /** Concept ids `distill` produced on this run. */
  readonly extractedConceptIds: readonly string[];
  /** Of those, the ones a `(:Concept)` node exists for after the run. */
  readonly mergedConceptIds: readonly string[];
}
