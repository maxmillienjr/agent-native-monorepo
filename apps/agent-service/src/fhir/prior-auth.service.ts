import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createLogger, errorType, withAgentSpan } from '@repo/telemetry';
import {
  PolicyCatalogue,
  decisionDueBy,
  loadPayer,
  operationOutcome,
  readSubmission,
  toClaimResponse,
  toResponseBundle,
  type Clock,
  type FhirBundle,
  type Payer,
} from '@repo/prior-auth';
import type { CaseRepository, RunRecordRepository } from '@repo/memory-core';
import { CASE_REPOSITORY, CHECKPOINTER, RUN_RECORDS } from '../memory/memory.tokens.js';
import { RunsService } from '../runs/runs.service.js';
import { buildPriorAuthGraph } from '../agent/prior-auth/graph.js';
import type { PriorAuthState } from '../agent/prior-auth/state.js';
import { recordingAssess } from '../agent/model/decision-seam.js';
import { RunRecorder } from '../audit/run-recorder.js';
import { RunRecordWriteError } from '../audit/persisting-deck.js';

const logger = createLogger('prior-auth');

/** Injection token for the clock `receivedAt` is read from, so a test can fix it. */
export const PRIOR_AUTH_CLOCK = 'PRIOR_AUTH_CLOCK';

/** `gen_ai.agent.name` on every prior-authorization run's root span. */
export const PRIOR_AUTH_AGENT_NAME = 'prior-auth';

/**
 * A 4xx answered with an `OperationOutcome`, which the FHIR exception filter
 * writes as the body unchanged.
 */
export class OperationOutcomeException extends HttpException {
  constructor(status: number, outcome: ReturnType<typeof operationOutcome>) {
    super(outcome, status);
  }
}

/** One `$submit`, with the trajectory the HTTP response does not carry. */
export interface PriorAuthRun {
  readonly caseId: string;
  readonly response: FhirBundle;
  readonly state: PriorAuthState;
  readonly nodeSequence: readonly string[];
  readonly traceId: string;
}

/**
 * Runs `$submit`: reads the bundle, starts the clock, runs the graph inline
 * under its run record, maps its disposition to a `ClaimResponse`, and
 * enqueues the case before it answers.
 *
 * Synchronous on purpose. The agent's work is one model call, and a referral
 * happens in the same exchange that received the request, so the tool holds
 * nothing: no retry loop, no wait (P3-D's second SB 1120 invariant). The case
 * row is the payer's queue, not the tool's: the graph has finished before it
 * is written, and its order is the clock's alone (P3-E).
 *
 * Two writes fail closed on this path, in this order, and either failing
 * answers 503 with an `OperationOutcome` and no `ClaimResponse`:
 *
 * 1. The run record (P3-B): opened before the graph runs, appended to at each
 *    decision, closed when it ends. A decision that cannot be recorded is not
 *    returned.
 * 2. The case row (P3-E): written only after the record has closed. A pended
 *    response for a case no queue holds would be a request nobody reviews.
 *
 * The order is chosen for what each failure leaves behind. If the record
 * fails, no case exists, so the queue never holds a request the provider was
 * told nothing about. If the case write fails, the record of a finished run
 * stays with no case beside it: an audit of agent work whose answer was never
 * returned, which a resubmission does not duplicate in the queue. The other
 * order would leave a pended case for a response that was never sent, and the
 * provider's resubmission would queue the request twice.
 */
@Injectable()
export class PriorAuthService {
  private readonly payer: Payer = loadPayer();
  private readonly catalogue: PolicyCatalogue = PolicyCatalogue.load();

  private readonly recorder: RunRecorder;

  // Explicit tokens: the dev path runs through tsx, which emits no decorator
  // metadata (`.context/conventions.md`).
  constructor(
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(CHECKPOINTER) private readonly checkpointer: BaseCheckpointSaver | null,
    @Inject(PRIOR_AUTH_CLOCK) private readonly clock: Clock,
    @Inject(RUN_RECORDS) runRecords: RunRecordRepository | null,
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
  ) {
    this.recorder = new RunRecorder(runRecords);
  }

  async submit(body: unknown, correlationId: string): Promise<PriorAuthRun> {
    // Answered before the clock starts or a case exists: a body this
    // operation cannot read is not a request the payer received.
    const submission = readSubmission(body, this.payer);
    if (submission.kind === 'invalid') {
      throw new OperationOutcomeException(
        HttpStatus.BAD_REQUEST,
        operationOutcome(submission.issues),
      );
    }
    if (submission.kind === 'unprocessable') {
      throw new OperationOutcomeException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        operationOutcome(submission.issues),
      );
    }

    const caseId = randomUUID();
    const received = this.clock.now();
    const receivedAt = received.toISOString();

    logger.info({ msg: 'prior-auth.start', correlationId, caseId });

    let run: PriorAuthRun;
    try {
      run = await withAgentSpan(
        { agentName: PRIOR_AUTH_AGENT_NAME, runId: caseId },
        async (agent) =>
          // Fail-closed (P3-B, decided at review): this path returns a
          // recommendation, and a decision that cannot be recorded is not
          // returned. The record's start time is `receivedAt`, which the graph
          // reads as an input, so a replay can serve it back.
          this.recorder.record(
            {
              runId: caseId,
              graph: 'prior-auth',
              sessionId: null,
              correlationId,
              request: body,
              modelAxis: this.runs.modelAxis(),
              startedAt: received,
            },
            'fail-closed',
            async (deck) => {
              const assess = this.runs.modelDeps().assess;
              const compiled = buildPriorAuthGraph(
                {
                  payer: this.payer,
                  catalogue: this.catalogue,
                  assess: deck === undefined ? assess : recordingAssess(assess, deck),
                  clock: this.clock,
                },
                this.checkpointer ?? undefined,
              );
              return this.run(compiled, { caseId, body, receivedAt, correlationId }, agent);
            },
          ),
      );
    } catch (error) {
      if (!(error instanceof RunRecordWriteError)) throw error;
      logger.error({ msg: 'prior-auth.unrecorded', correlationId, caseId, error: error.message });
      throw new OperationOutcomeException(
        HttpStatus.SERVICE_UNAVAILABLE,
        operationOutcome([
          {
            code: 'exception',
            diagnostics:
              'The request was received, but its audit record could not be written, so no ' +
              'decision is returned. Submit it again.',
          },
        ]),
      );
    }

    // After the record has closed: see the class comment for why this order.
    await this.enqueue(run, body, correlationId);
    return run;
  }

  /** Writes the case row, or answers 503 and returns nothing. */
  private async enqueue(run: PriorAuthRun, body: unknown, correlationId: string): Promise<void> {
    const { caseId, state, response } = run;
    const { request, disposition } = state;
    if (request === undefined || disposition === undefined) {
      throw new Error('a case is enqueued only after dispose');
    }
    const receivedAt = new Date(state.receivedAt);
    try {
      await this.cases.enqueue({
        caseId,
        status: disposition.kind === 'automated-approval' ? 'approved-automated' : 'pended',
        priority: request.priority,
        receivedAt,
        decisionDueBy:
          state.decisionDueBy === undefined
            ? decisionDueBy(receivedAt, request.priority)
            : new Date(state.decisionDueBy),
        memberId: request.memberId,
        insurerId: request.insurerId,
        providerId: request.providerId,
        hcpcs: request.hcpcs,
        // `readSubmission` accepted it, so it is a Bundle object: stored as
        // received, not as the passthrough parse re-ordered it.
        request: body as Record<string, unknown>,
        disposition,
        response: response as unknown as Record<string, unknown>,
        // P3-C's `disposition.recommended` seq, once a ledger is configured.
        recommendationSeq: null,
      });
    } catch (error) {
      logger.error({
        msg: 'prior-auth.enqueue.failed',
        correlationId,
        caseId,
        errorType: errorType(error),
      });
      throw new OperationOutcomeException(
        HttpStatus.SERVICE_UNAVAILABLE,
        operationOutcome([
          {
            code: 'exception',
            diagnostics:
              'The request could not be recorded for review, so no response is issued. ' +
              'Resubmit it.',
          },
        ]),
      );
    }
  }

  private async run(
    compiled: ReturnType<typeof buildPriorAuthGraph>,
    input: { caseId: string; body: unknown; receivedAt: string; correlationId: string },
    agent: { readonly traceId: string },
  ): Promise<PriorAuthRun> {
    const { caseId, body, receivedAt, correlationId } = input;

    // Streamed rather than invoked, so the node sequence is observable; every
    // channel is last-value-wins, so folding the updates is the final state.
    const nodeSequence: string[] = [];
    const folded: Record<string, unknown> = { caseId, bundle: body, receivedAt, findings: [] };
    const stream = await compiled.stream(
      { caseId, bundle: body, receivedAt, findings: [] },
      { configurable: { thread_id: caseId } },
    );
    for await (const chunk of stream) {
      for (const [node, update] of Object.entries(chunk)) {
        nodeSequence.push(node);
        Object.assign(folded, update);
      }
    }
    const state = folded as unknown as PriorAuthState;
    if (state.request === undefined || state.disposition === undefined) {
      throw new Error('the prior-authorization graph ended without a disposition');
    }

    const context = {
      respondedAt: this.clock.now(),
      caseId,
      ...(state.referralReason === undefined ? {} : { referralReason: state.referralReason }),
    };
    const claimResponse = toClaimResponse(
      state.request.claim,
      state.disposition,
      state.policy,
      context,
    );

    logger.info({
      msg: 'prior-auth.done',
      correlationId,
      caseId,
      disposition: state.disposition.kind,
    });

    return {
      caseId,
      response: toResponseBundle(state.request.bundle, claimResponse, context),
      state,
      nodeSequence,
      traceId: agent.traceId,
    };
  }
}
