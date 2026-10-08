import type { AgentState } from './state.js';

/**
 * Returns the name of the next node, so the conditional edge maps each literal
 * onto the node it names. Keeping a key of `reflect` pointed at the `distill`
 * node would work and would be the next reader's trap.
 *
 * A failed step aborts the loop whatever the step bound says.
 */
export function shouldContinueActing(state: AgentState): 'act' | 'distill' {
  if (state.aborted || !state.shouldContinue || state.stepCount >= state.maxSteps) {
    return 'distill';
  }
  return 'act';
}
