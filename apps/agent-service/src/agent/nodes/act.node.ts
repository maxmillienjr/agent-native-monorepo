import { withNodeSpan, withToolSpan } from '@repo/telemetry';
import type { AgentState } from '../graph/state.js';
import { addUsage, type CallUsage } from '../model/usage.js';

export interface Tool {
  name: string;
  execute: (input: unknown) => Promise<unknown>;
}

export interface ToolSelection {
  toolName: string;
  input: unknown;
}

export interface ActNodeDeps {
  tools: Tool[];
  /**
   * The model's choice, and what asking for it cost. `selection` is `null` when
   * the model wants no tool. The usage travels with the answer, as it does for
   * `callLlm`, so `RunResponse.tokenCounts` counts every call (P1-F).
   */
  selectTool: (
    plan: string,
    tools: Tool[],
  ) => Promise<{ selection: ToolSelection | null; tokenCounts: CallUsage }>;
}

export async function actNode(state: AgentState, deps: ActNodeDeps): Promise<Partial<AgentState>> {
  return withNodeSpan('act', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);
    span.setAttribute('step_count', state.stepCount);

    if (!state.currentPlan) {
      return {
        shouldContinue: false,
        stepCount: state.stepCount + 1,
      };
    }

    const { selection, tokenCounts: usage } = await deps.selectTool(state.currentPlan, deps.tools);
    // Every branch below paid for the selection, whatever it then did with it.
    const tokenCounts = addUsage(state.tokenCounts, usage);

    if (!selection) {
      // No tool needed — plan is complete
      return {
        shouldContinue: false,
        stepCount: state.stepCount + 1,
        tokenCounts,
      };
    }

    const tool = deps.tools.find((t) => t.name === selection.toolName);
    if (!tool) {
      return {
        toolOutputs: [
          ...state.toolOutputs,
          {
            toolName: selection.toolName,
            input: selection.input,
            output: null,
            error: `Tool "${selection.toolName}" not found`,
          },
        ],
        shouldContinue: false,
        stepCount: state.stepCount + 1,
        tokenCounts,
      };
    }

    try {
      // Its own span, named before the call, so a tool that throws still
      // says which tool it was. The input and the output are content and stay
      // off it.
      const output = await withToolSpan(selection.toolName, () => tool.execute(selection.input));

      return {
        toolOutputs: [
          ...state.toolOutputs,
          {
            toolName: selection.toolName,
            input: selection.input,
            output,
          },
        ],
        stepCount: state.stepCount + 1,
        shouldContinue: state.stepCount + 1 < state.maxSteps,
        tokenCounts,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        toolOutputs: [
          ...state.toolOutputs,
          {
            toolName: selection.toolName,
            input: selection.input,
            output: null,
            error: errorMessage,
          },
        ],
        stepCount: state.stepCount + 1,
        shouldContinue: false,
        tokenCounts,
      };
    }
  });
}
