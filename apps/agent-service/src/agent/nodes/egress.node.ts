import { withNodeSpan } from '@repo/telemetry';
import { RunResponseSchema, type RunResponse } from '@repo/agent-contracts';
import type { AgentState } from '../graph/state.js';

export async function egressNode(state: AgentState): Promise<Partial<AgentState>> {
  return withNodeSpan('egress', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);

    const hasErrors = state.toolOutputs.some((t) => t.error);
    const outcome = hasErrors ? ('partial' as const) : ('success' as const);

    span.setAttribute('outcome', outcome);

    return { outcome };
  });
}

/**
 * The response, parsed on the way out.
 *
 * `RunsService` hands this the graph's final state through an `unknown` cast,
 * and a state restored by the checkpointer is deserialized JSON no schema has
 * seen, so the types that built the response prove nothing about it. The parse
 * is the check that holds: a value that breaks the contract becomes a failed
 * run here rather than bytes a client trusts. `RunResponseSchema` is strict, so
 * an undeclared key throws instead of being silently stripped (P3-A).
 */
export function buildRunResponse(state: AgentState): RunResponse {
  return RunResponseSchema.parse({
    runId: state.runId,
    sessionId: state.sessionId,
    messages: state.messages,
    outcome: state.outcome ?? 'success',
    tokenCounts: state.tokenCounts,
    retrievedContext: state.retrievedContext,
  });
}
