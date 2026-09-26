import { withNodeSpan } from '@repo/telemetry';
import type { AgentState } from '../graph/state.js';

const SYSTEM_PROMPT = 'You are a helpful research assistant.';

export interface PlanNodeDeps {
  callLlm: (
    systemPrompt: string,
    userPrompt: string,
  ) => Promise<{
    content: string;
    tokenCounts: { prompt: number; completion: number };
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

      // Build context from messages and retrieved context
      const contextBlock =
        state.retrievedContext.length > 0
          ? `\n\nRelevant context:\n${state.retrievedContext.map((c) => `- [${c.source}] ${c.content}`).join('\n')}`
          : '';

      const conversationHistory = state.messages.map((m) => `${m.role}: ${m.content}`).join('\n');

      const userPrompt = `${conversationHistory}${contextBlock}\n\nBased on the above, create a plan to address the user's request.`;

      const response = await deps.callLlm(SYSTEM_PROMPT, userPrompt);

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
        tokenCounts: {
          prompt: state.tokenCounts.prompt + response.tokenCounts.prompt,
          completion: state.tokenCounts.completion + response.tokenCounts.completion,
        },
      };
    },
    { operation: 'plan' },
  );
}
