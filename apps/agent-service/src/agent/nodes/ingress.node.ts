import { withNodeSpan } from '@repo/telemetry';
import { RunRequestSchema, RunRequestConfigSchema } from '@repo/agent-contracts';
import { seedWorkingMemory } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';

export async function ingressNode(
  state: AgentState,
  rawBody: unknown,
  correlationId: string,
): Promise<Partial<AgentState>> {
  return withNodeSpan('ingress', async (span) => {
    const request = RunRequestSchema.parse(rawBody);

    // The runId arrives in the initial state, minted by RunsService, because
    // it is also the checkpointer's thread_id and has to exist before the
    // invoke. Minting a fresh one here would leave the run's checkpoints
    // filed under an id that appears nowhere in its response — the run could
    // not be resumed by the identifier its caller was given.
    const runId = state.runId;

    span.setAttribute('run_id', runId);
    span.setAttribute('session_id', request.sessionId);

    const workingMemory = seedWorkingMemory({
      runId,
      sessionId: request.sessionId,
      correlationId,
      messages: request.messages,
    });

    // Parsed rather than defaulted inline, so the defaults stay in the
    // contract instead of being re-spelled here.
    const config = RunRequestConfigSchema.parse(request.config ?? {});

    return {
      ...workingMemory,
      maxSteps: config.maxSteps,
      topK: config.topK,
      stepCount: 0,
      shouldContinue: true,
      aborted: false,
      toolOutputs: [],
    };
  });
}
