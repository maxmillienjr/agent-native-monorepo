import { interrupt } from '@langchain/langgraph';
import { withNodeSpan } from '@repo/telemetry';
import {
  ApprovalDecisionSchema,
  type AgentState,
  type ApprovalDecision,
  type PendingApproval,
  type ToolOutput,
} from '../graph/state.js';
import type { ToolRegistry } from '../tools/registry.js';
import { runTool } from './act.node.js';

export interface ApproveNodeDeps {
  readonly registry: ToolRegistry;
}

/** `approve` was entered with nothing to decide, which only a wrong edge can cause. */
export class NothingPendingError extends Error {
  constructor() {
    super('approve was reached with no pending approval');
    this.name = 'NothingPendingError';
  }
}

/**
 * Pauses the run before an irreversible call, and runs or refuses the call on
 * the decision it is resumed with.
 *
 * A node of its own, after `act`, so that nothing nondeterministic runs before
 * the pause: a resumed node runs again from its first line, and an
 * `interrupt()` placed after `selectTool` would ask the model again after the
 * approval and could execute a selection nobody approved. Here the first
 * thing that can happen is the `interrupt()`, over a call `act` already
 * validated and wrote into state.
 *
 * The `interrupt()` is outside the node span and outside any `try`. A
 * `GraphInterrupt` is a throw, and a span or a `catch` around it would record
 * every pause as an error or swallow it. The pause is visible on the `act`
 * span that requested it (`tool.awaiting_approval`); this node's span covers
 * the decision.
 *
 * The resume value is parsed by `responseSchema`, which on LangGraph 1.4 throws
 * a `ZodError` and leaves the thread paused for any value that is not an
 * `ApprovalDecision`. The other resume hazards P3-E probed on 0.4.10 hold on
 * 1.4.19 too: a resume on a finished thread is a silent no-op, a resume on an
 * unknown thread creates it, and two concurrent resumes both succeed. None is
 * reachable here, because nothing resumes a run over HTTP; the PRD that adds
 * the first irreversible tool owns the endpoint and the guard against them.
 */
export async function approveNode(
  state: AgentState,
  deps: ApproveNodeDeps,
): Promise<Partial<AgentState>> {
  const pending = state.pendingApproval;
  if (!pending) throw new NothingPendingError();

  const decision = interrupt<PendingApproval, ApprovalDecision>(pending, {
    responseSchema: ApprovalDecisionSchema,
  });

  return withNodeSpan('approve', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);

    const recorded = {
      toolName: pending.toolName,
      input: pending.input,
      output: null,
      tier: pending.tier,
      idempotencyKey: pending.idempotencyKey,
      effect: 'none' as const,
      approver: decision.approver,
    };
    const abort = (output: ToolOutput): Partial<AgentState> => ({
      toolOutputs: [...state.toolOutputs, output],
      pendingApproval: null,
      aborted: true,
      shouldContinue: false,
    });

    if (!decision.approved) {
      return abort({ ...recorded, error: `approval rejected by ${decision.approver}` });
    }

    // The registry and the input are checked again: the pending call was read
    // back from a checkpoint, which may have been written by another deploy.
    const tool = deps.registry.get(pending.toolName);
    if (tool?.tier !== 'irreversible') {
      return abort({
        ...recorded,
        error: `"${pending.toolName}" is not an irreversible tool in this registry`,
      });
    }
    const parsed = tool.input.safeParse(pending.input);
    if (!parsed.success) {
      return abort({ ...recorded, error: `the approved input no longer fits ${tool.name}` });
    }

    const output = await runTool(tool, parsed.data, {
      runId: state.runId,
      idempotencyKey: pending.idempotencyKey,
    });
    if (output.error !== undefined) return abort({ ...output, approver: decision.approver });

    return {
      toolOutputs: [...state.toolOutputs, { ...output, approver: decision.approver }],
      pendingApproval: null,
      shouldContinue: state.stepCount < state.maxSteps,
    };
  });
}
