import { withNodeSpan } from '@repo/telemetry';
import type { AgentState } from '../graph/state.js';
import { addUsage, type CallUsage } from '../model/usage.js';

/**
 * Everything after the first sentence is P1-I's. On `gemini-2.5-flash` the plan
 * for a request the context could not answer said to search. On
 * `gemini-3.5-flash-lite`, with the first sentence alone, it planned to answer
 * from the context in 2 of 3 samples, `act.selectTool` read that plan and chose
 * `null`, and `tool-use-001` failed 5 of 5 live trials; thinking at `low` or
 * `medium` did not change it. A sentence telling it to "name a tool step" fixed
 * that and broke `tool-use-002`: the plan invented tool names the registry does
 * not have, and the selector matched none. Describing what a step must find or
 * do, and not naming tools, passed 30 of 30 live trials over the three
 * memory-recall tasks on 2026-11-09.
 */
export const PLAN_SYSTEM_PROMPT =
  'You are a helpful research assistant. After you plan, tools carry the plan out. Wherever a step needs information that is not in the conversation or the retrieved context, or needs an action taken, say what that step must find or do. Do not name tools: you are not shown which exist.';

/** The last line of `plan`'s user prompt, after the transcript and the context. */
export const PLAN_INSTRUCTION = "Based on the above, create a plan to address the user's request.";

/**
 * `plan`'s user prompt for a state: the transcript, the retrieved context if
 * there is any, and the instruction.
 *
 * Exported so that `plan.node.test.ts` can pin its bytes: every recorded
 * `plan` request hashes them, so a change here is a re-record.
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
