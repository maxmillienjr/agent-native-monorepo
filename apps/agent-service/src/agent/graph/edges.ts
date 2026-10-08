import type { AgentState } from './state.js';

/** Whether any step's effect is still applied, which is what `compensate` undoes. */
export function hasAppliedEffect(state: AgentState): boolean {
  return state.toolOutputs.some((output) => output.effect === 'applied');
}

/**
 * Where `act`, and `approve` after it, hand over.
 *
 * Returns the name of the next node, so the conditional edge maps each literal
 * onto the node it names. Keeping a key of `reflect` pointed at the `distill`
 * node would work and would be the next reader's trap.
 *
 * ```text
 * act ──▶ approve     an irreversible call is waiting on a person
 *     ──▶ compensate  a step failed, and an effect is applied
 *     ──▶ distill     a step failed with nothing to undo; or done, suppressed, out of steps
 *     ──▶ act         the selection ran and steps remain
 * ```
 *
 * The order matters: a pending approval is checked first because nothing else
 * may run before it is decided, and an abort before the step bound because a
 * run that failed on its last step still has effects to undo.
 */
export function shouldContinueActing(
  state: AgentState,
): 'act' | 'approve' | 'compensate' | 'distill' {
  if (state.pendingApproval) return 'approve';
  if (state.aborted) return hasAppliedEffect(state) ? 'compensate' : 'distill';
  if (!state.shouldContinue || state.stepCount >= state.maxSteps) {
    return 'distill';
  }
  return 'act';
}

/** `compensate` undoes one effect per pass, newest first, until none is applied. */
export function shouldKeepCompensating(state: AgentState): 'compensate' | 'distill' {
  return hasAppliedEffect(state) ? 'compensate' : 'distill';
}
