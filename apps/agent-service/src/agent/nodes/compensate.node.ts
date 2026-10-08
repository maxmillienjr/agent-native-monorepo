import { withNodeSpan, withToolSpan } from '@repo/telemetry';
import type { AgentState } from '../graph/state.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolArgs } from '../tools/types.js';

export interface CompensateNodeDeps {
  readonly registry: ToolRegistry;
}

/** A step whose effect cannot be undone by the registry this run has. */
export class CompensationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompensationError';
  }
}

/**
 * Undoes the newest applied effect, one per pass (the saga's backward recovery).
 *
 * One effect per pass, with the edge looping back while any is applied, so
 * that each undo is checkpointed as it lands. A compensation that exhausts
 * `IO_RETRY` throws and the run fails whole, and its checkpoint then lists
 * which effects were undone and which were not; an effect already marked
 * `compensated` — by an earlier pass, or before a resume — is never undone
 * again. Within a pass a retried attempt calls the same `compensate` with the
 * same key, which is why compensations must be idempotent on it.
 *
 * Runs on any failed step, including on replay, where the compensation is
 * served from the cassette and the ordering is what is exercised.
 */
export async function compensateNode(
  state: AgentState,
  deps: CompensateNodeDeps,
): Promise<Partial<AgentState>> {
  return withNodeSpan('compensate', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);

    const index = newestApplied(state.toolOutputs);
    if (index < 0) return {};

    const effect = state.toolOutputs[index]!;
    const tool = deps.registry.get(effect.toolName);
    if (tool?.tier !== 'compensable') {
      // The registry changed between the step and its undo, which only a
      // resume across a deploy can do. Failing the run keeps the effect
      // listed as applied, which is the truth.
      throw new CompensationError(
        `"${effect.toolName}" left an applied effect and is not a compensable tool in this registry`,
      );
    }

    await withToolSpan(tool.name, (toolSpan) => {
      toolSpan.setAttribute('tool.tier', tool.tier);
      toolSpan.setAttribute('tool.compensation', true);
      return tool.compensate(effect.input as ToolArgs, effect.output, {
        runId: state.runId,
        idempotencyKey: effect.idempotencyKey,
      });
    });

    return {
      toolOutputs: state.toolOutputs.map((output, position) =>
        position === index ? { ...output, effect: 'compensated' as const } : output,
      ),
    };
  });
}

function newestApplied(outputs: AgentState['toolOutputs']): number {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    if (outputs[index]!.effect === 'applied') return index;
  }
  return -1;
}
