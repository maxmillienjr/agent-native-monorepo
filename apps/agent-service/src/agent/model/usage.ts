import { chatUsage } from '@repo/telemetry';
import type { AgentState } from '../graph/state.js';

/**
 * What one chat call used, as a `ModelDeps` seam returns it.
 *
 * `completion` is billed output: the visible answer plus the thinking tokens
 * `gemini-2.5-flash` is billed for. `reasoning` is the thinking share of it,
 * present only when the reply reported a total to derive it from. The shape is
 * the cassette's `tokenCounts`, so a recorded decision carries exactly what the
 * seam returned.
 */
export interface CallUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly reasoning?: number;
}

/** A seam that made no billed call — the stub axis. */
export const NO_USAGE: CallUsage = { prompt: 0, completion: 0 };

/**
 * A chat reply's usage, by the same derivation the inference span records.
 *
 * Both go through `chatUsage`, so `RunResponse.tokenCounts` and the sum of
 * `gen_ai.usage.*` over a run's spans cannot drift apart: on a live run with
 * no node retry they are equal, and P1-F's live criterion checks that they are.
 * An absent count is zero here, where the span would leave it unset — state has
 * to hold a number, and the budget check reads the spans, where absent stays
 * absent.
 */
export function usageOf(meta: Parameters<typeof chatUsage>[0] | undefined): CallUsage {
  const usage = meta === undefined ? {} : chatUsage(meta);
  return {
    prompt: usage.input ?? 0,
    completion: usage.output ?? 0,
    ...(usage.reasoningOutput === undefined ? {} : { reasoning: usage.reasoningOutput }),
  };
}

/**
 * The run's total after one more call, as a node writes it back to state.
 *
 * `reasoning` is not carried into state: `RunResponse.tokenCounts` is
 * `{ prompt, completion }` and its shape does not change, and the thinking
 * share is on the spans for anyone who wants it.
 */
export function addUsage(
  total: AgentState['tokenCounts'],
  call: CallUsage,
): AgentState['tokenCounts'] {
  return { prompt: total.prompt + call.prompt, completion: total.completion + call.completion };
}
