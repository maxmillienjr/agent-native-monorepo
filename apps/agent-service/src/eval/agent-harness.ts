import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type pg from 'pg';
import type { Driver } from 'neo4j-driver';
import {
  PgNeo4jMemoryInspector,
  PgNeo4jSeedManager,
  type MemoryInspector,
  type SeedManager,
} from '@repo/memory-core';
import {
  detectAxes,
  fixtureEmbedding,
  type AgentHarness,
  type Axes,
  type MemoryOutcome,
  type SpanRecord,
  type Task,
  type Transcript,
} from '@repo/eval-harness';
import { AppModule } from '../app.module.js';
import { PG_POOL, NEO4J_DRIVER } from '../memory/memory.tokens.js';
import { RunsService, type TracedRun } from '../runs/runs.service.js';
import { recordingModelDeps, replayModelDeps, type TrialDecks } from './cassette-deps.js';
import type { SpanCollector } from './span-records.js';

/**
 * The adapter between `packages/eval-harness` and this service.
 *
 * It boots the real application context rather than composing its own
 * dependency set, so a trial exercises the same `MemoryModule` providers, the
 * same model axis and the same checkpointer a request would. An evaluation
 * that wires up its own graph measures a system nobody deploys.
 *
 * It lives here rather than in the package for the obvious reason: a package
 * that imports an app is backwards. `AgentHarness` is the seam, and everything
 * on this side of it knows about Nest.
 */
export class AgentServiceHarness implements AgentHarness<MemoryOutcome> {
  readonly name = 'agent-service';

  /**
   * What `distill` produced on each run, kept until its outcome is captured.
   *
   * `Transcript` is the system-agnostic record and has no business carrying an
   * extraction, but `entity_merged` has to ask whether *this run's* concepts
   * reached the graph — and `mergeEntity` writes no episode onto a `:Concept`,
   * so there is nothing on the node to ask with. The fact texts are kept for
   * the red team's `canary_absent_from_extraction` (P4-B), which asks what
   * `reflect` was handed rather than what rows it wrote.
   */
  private readonly extractionByRun = new Map<
    string,
    { conceptIds: string[]; factTexts: string[] }
  >();

  /**
   * Which trial of each task is next, so the right cassette is opened.
   *
   * It is counted here rather than passed in because `AgentHarness.run(task)`
   * takes no index and widening that interface would make every implementor pay
   * for one adapter's bookkeeping. `reset(task)` is called exactly once before
   * every trial — the runner's fixed order is reset, run, capture, grade — so
   * counting resets counts trials.
   */
  private readonly trialIndexByTask = new Map<string, number>();

  constructor(
    private readonly context: INestApplicationContext,
    private readonly runs: RunsService,
    private readonly inspector: MemoryInspector,
    private readonly seeds: SeedManager,
    private readonly decks?: TrialDecks,
    private readonly spans?: SpanCollector,
  ) {
    // Installed once, reading the deck the current trial opened. The service
    // learns that its model half can be decorated and nothing else; replay
    // ignores `live` entirely, which is why no model client is constructed on
    // that path.
    if (decks !== undefined) {
      this.runs.setModelDecorator((live) =>
        this.deck === undefined
          ? live
          : this.deck.mode === 'replay'
            ? replayModelDeps(this.deck)
            : recordingModelDeps(live, this.deck),
      );
    }
  }

  private deck: ReturnType<TrialDecks['open']> | undefined;

  axes(): Axes {
    return detectAxes();
  }

  /**
   * Removes what the previous trial wrote, then lays the task's seed back down.
   *
   * Both halves are needed. Deleting alone leaves a two-task suite unrepeatable
   * — the Neo4j side of `restoreToSeed` is database-wide, because neither
   * `:Concept` nor `:Fact` carries a session, so task 2's reset takes task 1's
   * concepts with it. Applying alone leaves the previous trial's episodes and
   * facts in place, and `episodes` is keyed on `(session_id, turn_index)` with
   * first write wins, so trial 2 would write no row and its `run_id` would
   * appear nowhere.
   *
   * It also means a run needs no seeding step before it: an empty database,
   * migrated by `MemoryModule` on boot, is enough. The nightly workflow's seed
   * script existed for a suite that never read what it wrote, and P1-C deleted
   * both.
   */
  async reset(task: Task<MemoryOutcome>): Promise<void> {
    const trialIndex = (this.trialIndexByTask.get(task.id) ?? -1) + 1;
    this.trialIndexByTask.set(task.id, trialIndex);
    this.deck = this.decks?.open(task.id, trialIndex);

    // Every session the task names, not only the graded one (P4-B). A prior
    // run writes into its own session, and a trial that left the attacker's
    // turn behind would hand the next trial a store it did not seed — with the
    // episodes' first write winning, the next prior run would write no row.
    for (const sessionId of sessionsNamedBy(task)) {
      await this.seeds.restoreToSeed({
        sessionId,
        conceptIds: task.seeds.neo4j.map((concept) => concept.id),
        // Both indices' hashes, because the Neo4j half of the restore keeps a
        // `:Fact` only if its hash is listed — a graph fact left off this list
        // is deleted by the reset that is supposed to preserve it.
        contentHashes: [
          ...task.seeds.pgvector.map((fact) => fact.contentHash),
          ...task.seeds.graphFacts.map((fact) => fact.contentHash),
        ],
      });
    }

    await this.seeds.applySeed({
      concepts: task.seeds.neo4j,
      relationships: task.seeds.relationships,
      facts: task.seeds.pgvector.map((fact) => ({ ...fact, embedding: fixtureEmbedding() })),
      graphFacts: task.seeds.graphFacts,
    });
  }

  /**
   * The trial: any prior runs the task names, in order, then the graded run.
   *
   * Only the graded run is the transcript. The prior runs' traces ride after
   * its own, so the trial's budget counts every call the trial made, and
   * `latencyMs` is the whole trial's.
   */
  async run(task: Task<MemoryOutcome>): Promise<Transcript> {
    const startedAt = Date.now();
    const { traced, priorSpans } = await this.tracedRuns(task);
    const latencyMs = Date.now() - startedAt;

    this.extractionByRun.set(traced.response.runId, {
      conceptIds: (traced.extraction?.entities ?? []).map((entity) => entity.id),
      factTexts: (traced.extraction?.facts ?? []).map((fact) => fact.text),
    });

    return {
      runId: traced.response.runId,
      sessionId: traced.response.sessionId,
      messages: traced.response.messages,
      nodeSequence: traced.nodeSequence,
      toolCalls: traced.toolOutputs.map((output) => ({
        name: output.toolName,
        input: output.input,
        output: output.output,
        // Preserved rather than normalized away: an errored call is a call that
        // happened and did not succeed, and the trajectory metrics need both
        // halves of that.
        ...(output.error === undefined ? {} : { error: output.error }),
      })),
      retrievedContext: traced.response.retrievedContext.map((candidate) => ({
        source: candidate.source,
        content: candidate.content,
        score: candidate.score,
      })),
      tokenCounts: traced.response.tokenCounts,
      outcome: traced.response.outcome,
      latencyMs,
      // The run's trace, on every axis. Taken before `captureOutcome`, whose
      // inspection spans are the harness's and not the run's. The graded
      // run's first, so the first root is the run the graders judged.
      ...(this.spans === undefined
        ? {}
        : { spans: [...this.spans.take(traced.traceId), ...priorSpans] }),
    };
  }

  /**
   * The trial's runs, wrapped so the trial's deck is always finished — once,
   * after the last of them, because one cassette holds the whole trial.
   *
   * `completed` rather than "we reached the finally": a cassette written from a
   * crashed run replays a run that never happened, and a replay that ended
   * early has recorded decisions left over — which the deck reports only when
   * the trial was supposed to have consumed them.
   *
   * A prior run's spans are taken as soon as it ends. The collector hands back
   * one trace and drops everything else it holds, so waiting until the graded
   * run would lose them.
   */
  private async tracedRuns(
    task: Task<MemoryOutcome>,
  ): Promise<{ traced: TracedRun; priorSpans: SpanRecord[] }> {
    let completed = false;
    try {
      const priorSpans: SpanRecord[] = [];
      for (const body of task.priorInputs ?? []) {
        const prior = await this.runs.executeTraced({
          body,
          correlationId: `eval-${randomUUID()}`,
        });
        if (this.spans !== undefined) priorSpans.push(...this.spans.take(prior.traceId));
      }
      const traced = await this.runs.executeTraced({
        body: task.input,
        correlationId: `eval-${randomUUID()}`,
      });
      completed = true;
      return { traced, priorSpans };
    } finally {
      await this.decks?.close(completed);
      this.deck = undefined;
    }
  }

  async captureOutcome(_task: Task<MemoryOutcome>, transcript: Transcript): Promise<MemoryOutcome> {
    const extraction = this.extractionByRun.get(transcript.runId);
    this.extractionByRun.delete(transcript.runId);
    const extractedConceptIds = extraction?.conceptIds ?? [];

    const inspection = await this.inspector.inspectRun({
      runId: transcript.runId,
      conceptIds: extractedConceptIds,
    });

    return {
      runId: transcript.runId,
      sessionId: transcript.sessionId,
      episodeRowsForRun: inspection.episodeRowsForRun,
      factRowsForRun: inspection.factRowsForRun,
      factNodesForRun: inspection.factNodesForRun,
      extractedConceptIds,
      mergedConceptIds: inspection.presentConceptIds,
      extractedFactTexts: extraction?.factTexts ?? [],
    };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/**
 * Every session a task names: the graded input's, each prior run's, and each
 * seeded fact's, in that order and without repeats.
 *
 * Exported for its unit test. The seeded sessions are included because a seed
 * may own a fact in a session no run uses — the attacker's, in a cross-session
 * case — and restoring it is what removes anything a trial left there.
 */
export function sessionsNamedBy(task: Task<MemoryOutcome>): string[] {
  const sessionOf = (input: unknown): string => (input as { sessionId: string }).sessionId;
  return [
    ...new Set([
      sessionOf(task.input),
      ...(task.priorInputs ?? []).map(sessionOf),
      ...task.seeds.pgvector.map((fact) => fact.sessionId),
    ]),
  ];
}

/**
 * Boots the service as an application context and wires the harness to it.
 *
 * `createApplicationContext` rather than `create`: the graph does not need an
 * HTTP listener to run, and binding a port would make two concurrent eval runs
 * collide. `abortOnError: false` for the reason `main.ts` gives — Nest aborts
 * the process with SIGABRT and no message when a provider factory throws, and a
 * misconfigured memory axis is a configuration mistake whose message is the
 * whole point.
 */
export async function createAgentServiceHarness(
  decks?: TrialDecks,
  spans?: SpanCollector,
): Promise<AgentServiceHarness> {
  const context = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: false,
  });

  const pool = context.get<pg.Pool | null>(PG_POOL);
  const driver = context.get<Driver | null>(NEO4J_DRIVER);

  if (!pool || !driver) {
    await context.close();
    throw new Error(
      'the memory axis is unconfigured: set DATABASE_URL and NEO4J_URI. ' +
        'Outcome graders read persisted state, and against the no-op writers they ' +
        'cannot tell "wrote nothing" from "there was nowhere to write".',
    );
  }

  return new AgentServiceHarness(
    context,
    context.get(RunsService),
    new PgNeo4jMemoryInspector(pool, driver),
    new PgNeo4jSeedManager(pool, driver),
    decks,
    spans,
  );
}
