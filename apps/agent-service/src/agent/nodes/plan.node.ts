import { withNodeSpan } from '@repo/telemetry';
import type { AgentState } from '../graph/state.js';
import { addUsage, type CallUsage } from '../model/usage.js';

export const PLAN_SYSTEM_PROMPT = 'You are a helpful research assistant.';

/** The last line of `plan`'s user prompt, after the transcript and the context. */
export const PLAN_INSTRUCTION = "Based on the above, create a plan to address the user's request.";

/**
 * `plan`'s user prompt for a state: the transcript, the retrieved context if
 * there is any, and the instruction.
 *
 * Exported so that P2-D's stage 2 can ask the model exactly what this node
 * asks it, and a test can hold the two equal. A copy of the template in the
 * evaluation would let the measured prompt drift from the shipped one.
 */
export function buildPlanPrompt(state: Pick<AgentState, 'messages' | 'retrievedContext'>): string {
  // Build context from messages and retrieved context
  const contextBlock =
    state.retrievedContext.length > 0
      ? `\n\nRelevant context:\n${state.retrievedContext.map((c) => `- [${c.source}] ${c.content}`).join('\n')}`
      : '';

  const conversationHistory = state.messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  return `${conversationHistory}${contextBlock}\n\n${PLAN_INSTRUCTION}`;
}

export interface PlanNodeDeps {
  callLlm: (
    systemPrompt: string,
    userPrompt: string,
  ) => Promise<{
    content: string;
    tokenCounts: CallUsage;
  }>;
}

export async function planNode(
  state: AgentState,
  deps: PlanNodeDeps,
): Promise<Partial<AgentState>> {
  return withNodeSpan(
    'plan',
    async (span) => {
      span.setAttribute('run_id', state.runId);
      span.setAttribute('session_id', state.sessionId);

      const response = await deps.callLlm(PLAN_SYSTEM_PROMPT, buildPlanPrompt(state));

      // Usage is on the inference span beneath this one, where the client
      // recorded it. A copy here would be counted twice by anything summing
      // `gen_ai.usage.*` over the trace.

      return {
        currentPlan: response.content,
        // The assistant's turn joins the transcript. Nothing wrote `messages`
        // after `ingress`, so `RunResponse.messages` echoed the request back
        // and `reflect` persisted a conversation with only one side of it —
        // against an Episodic tier specified to hold the full turn history.
        messages: [...state.messages, { role: 'assistant' as const, content: response.content }],
        tokenCounts: addUsage(state.tokenCounts, response.tokenCounts),
      };
    },
    { operation: 'plan' },
  );
}
