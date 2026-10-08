import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createLogger, withAgentSpan } from '@repo/telemetry';
import {
  PolicyCatalogue,
  loadPayer,
  operationOutcome,
  readSubmission,
  toClaimResponse,
  toResponseBundle,
  type Clock,
  type FhirBundle,
  type Payer,
} from '@repo/prior-auth';
import { CHECKPOINTER } from '../memory/memory.tokens.js';
import { RunsService } from '../runs/runs.service.js';
import { buildPriorAuthGraph } from '../agent/prior-auth/graph.js';
import type { PriorAuthState } from '../agent/prior-auth/state.js';

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
 * and maps its disposition to a `ClaimResponse`.
 *
 * Synchronous on purpose. The agent's work is one model call, and a referral
 * happens in the same exchange that received the request, so the tool holds
 * nothing: no queue, no retry loop, no wait (P3-D's second SB 1120
 * invariant). A pended response is a complete answer to `$submit`; what
 * happens to the case afterwards is P3-E's.
 */
@Injectable()
export class PriorAuthService {
  private readonly payer: Payer = loadPayer();
  private readonly catalogue: PolicyCatalogue = PolicyCatalogue.load();

  // Explicit tokens: the dev path runs through tsx, which emits no decorator
  // metadata (`.context/conventions.md`).
  constructor(
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(CHECKPOINTER) private readonly checkpointer: BaseCheckpointSaver | null,
    @Inject(PRIOR_AUTH_CLOCK) private readonly clock: Clock,
  ) {}

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
    const receivedAt = this.clock.now().toISOString();
    const compiled = buildPriorAuthGraph(
      {
        payer: this.payer,
        catalogue: this.catalogue,
        assess: this.runs.modelDeps().assess,
        clock: this.clock,
      },
      this.checkpointer ?? undefined,
    );

    logger.info({ msg: 'prior-auth.start', correlationId, caseId });

    return withAgentSpan({ agentName: PRIOR_AUTH_AGENT_NAME, runId: caseId }, async (agent) => {
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
    });
  }
}
