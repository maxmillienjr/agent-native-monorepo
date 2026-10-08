import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  detectAxes,
  type AgentHarness,
  type Axes,
  type PriorAuthOutcome,
  type Task,
  type Transcript,
} from '@repo/eval-harness';
import { AppModule } from '../app.module.js';
import { PriorAuthService, type PriorAuthRun } from '../fhir/prior-auth.service.js';
import { RunsService } from '../runs/runs.service.js';
import { deckDecorator, type TrialDecks } from './cassette-deps.js';
import type { SpanCollector } from './span-records.js';

/**
 * The adapter between `@repo/eval-harness` and the prior-authorization
 * surface (P3-D).
 *
 * It runs `PriorAuthService.submit`, the same call `POST /fhir/Claim/$submit`
 * makes, inside the real application context, so a trial exercises the same
 * model axis, decorator and checkpointer a request would. There are no seeds:
 * the graph neither retrieves nor reflects, and the request bundle is the
 * whole of what it reads.
 */
export class PriorAuthHarness implements AgentHarness<PriorAuthOutcome> {
  readonly name = 'agent-service/prior-auth';

  /** Each run's graph state, kept until its outcome is captured. */
  private readonly runs = new Map<string, PriorAuthRun>();
  /** Which trial of each task is next; see `AgentServiceHarness`. */
  private readonly trialIndexByTask = new Map<string, number>();
  private deck: ReturnType<TrialDecks['open']> | undefined;

  constructor(
    private readonly context: INestApplicationContext,
    private readonly priorAuth: PriorAuthService,
    runsService: RunsService,
    private readonly decks?: TrialDecks,
    private readonly spans?: SpanCollector,
  ) {
    if (decks !== undefined) {
      runsService.setModelDecorator(
        deckDecorator(() => this.deck),
        // A trial's run record names what decided it (P3-B).
        decks.mode === 'replay' ? 'replay' : undefined,
      );
    }
  }

  axes(): Axes {
    return detectAxes();
  }

  /** Opens the trial's deck. There is no store state to restore. */
  async reset(task: Task<PriorAuthOutcome>): Promise<void> {
    const trialIndex = (this.trialIndexByTask.get(task.id) ?? -1) + 1;
    this.trialIndexByTask.set(task.id, trialIndex);
    this.deck = this.decks?.open(task.id, trialIndex);
  }

  async run(task: Task<PriorAuthOutcome>): Promise<Transcript> {
    const startedAt = Date.now();
    let completed = false;
    let run: PriorAuthRun;
    try {
      run = await this.priorAuth.submit(task.input, `eval-${randomUUID()}`);
      completed = true;
    } finally {
      await this.decks?.close(completed);
      this.deck = undefined;
    }
    this.runs.set(run.caseId, run);

    return {
      runId: run.caseId,
      sessionId: run.caseId,
      messages: [],
      nodeSequence: run.nodeSequence,
      toolCalls: [],
      retrievedContext: [],
      tokenCounts: { prompt: 0, completion: 0 },
      outcome: 'success',
      latencyMs: Date.now() - startedAt,
      ...(this.spans === undefined ? {} : { spans: this.spans.take(run.traceId) }),
    };
  }

  async captureOutcome(
    _task: Task<PriorAuthOutcome>,
    transcript: Transcript,
  ): Promise<PriorAuthOutcome> {
    const run = this.runs.get(transcript.runId);
    this.runs.delete(transcript.runId);
    const disposition = run?.state.disposition;
    if (run === undefined || disposition === undefined) {
      throw new Error(`no prior-authorization run was recorded for ${transcript.runId}`);
    }

    const findings =
      disposition.kind === 'refer-to-clinician'
        ? disposition.findings.map(({ criterionId, status }) => ({ criterionId, status }))
        : disposition.criteriaMet.map((criterionId) => ({ criterionId, status: 'met' }));

    return {
      disposition: disposition.kind,
      assessed: run.nodeSequence.includes('assess'),
      findings,
      citations: run.state.findings.flatMap((finding) => finding.evidence),
      resourceIds: run.state.request?.resourceIds ?? [],
    };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/**
 * Boots the service as an application context and wires the harness to it.
 *
 * Unlike the memory-recall harness it does not require the stores: the graph
 * reads none, and on the stub model axis every task is skipped before a trial
 * runs. A recording still needs them, because the cassette header pins memory
 * to `live`, and the run checkpoints each case when they are configured.
 */
export async function createPriorAuthHarness(
  decks?: TrialDecks,
  spans?: SpanCollector,
): Promise<PriorAuthHarness> {
  const context = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: false,
  });
  return new PriorAuthHarness(
    context,
    context.get(PriorAuthService),
    context.get(RunsService),
    decks,
    spans,
  );
}
