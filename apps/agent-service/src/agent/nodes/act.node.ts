import { withNodeSpan, withToolSpan } from '@repo/telemetry';
import type { AgentState, ToolOutput } from '../graph/state.js';
import { addUsage, type CallUsage } from '../model/usage.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  selectionRequest,
  type ToolSelection,
  type ToolSelectionRequest,
} from '../tools/selection.js';
import type { ToolArgs, ToolContext, ToolDefinition } from '../tools/types.js';

export interface ActNodeDeps {
  readonly registry: ToolRegistry;
  /**
   * The model's choice, and what asking for it cost. `selection` is `null` when
   * the model wants no tool. The usage travels with the answer, as it does for
   * `callLlm`, so `RunResponse.tokenCounts` counts every call (P1-F). A
   * response that does not parse throws `SelectionFormatError`, which
   * `IO_RETRY` retries; it is never read as `null`.
   */
  selectTool: (
    request: ToolSelectionRequest,
  ) => Promise<{ selection: ToolSelection | null; tokenCounts: CallUsage }>;
}

/** `${runId}:${stepCount}`: the same on a retry of one step, different on the next. */
export function stepKey(runId: string, stepCount: number): string {
  return `${runId}:${stepCount}`;
}

/**
 * One step: ask for a selection, then check it before anything runs.
 *
 * In order — an unknown tool aborts; an input its schema refuses aborts with
 * the Zod issues, and `execute` is not called; a `(tool, input)` pair that
 * already succeeded in this run is suppressed and ends the loop without an
 * error; an irreversible tool is refused; anything else executes. Every
 * failure aborts the loop, so a partial sequence of effects is never left for
 * the model to improvise around.
 */
export async function actNode(state: AgentState, deps: ActNodeDeps): Promise<Partial<AgentState>> {
  return withNodeSpan('act', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);
    span.setAttribute('step_count', state.stepCount);

    const stepCount = state.stepCount + 1;

    if (!state.currentPlan) {
      return { shouldContinue: false, stepCount };
    }

    const { selection, tokenCounts: usage } = await deps.selectTool(
      selectionRequest(state.currentPlan, deps.registry, state.toolOutputs),
    );
    // Every branch below paid for the selection, whatever it then did with it.
    const tokenCounts = addUsage(state.tokenCounts, usage);

    if (!selection) {
      // No tool needed — plan is complete
      return { shouldContinue: false, stepCount, tokenCounts };
    }

    const idempotencyKey = stepKey(state.runId, state.stepCount);
    const abort = (output: ToolOutput): Partial<AgentState> => ({
      toolOutputs: [...state.toolOutputs, output],
      aborted: true,
      shouldContinue: false,
      stepCount,
      tokenCounts,
    });

    const tool = deps.registry.get(selection.toolName);
    if (!tool) {
      return abort({
        toolName: selection.toolName,
        input: selection.input,
        output: null,
        error: `Tool "${selection.toolName}" not found`,
        idempotencyKey,
        effect: 'none',
      });
    }

    const parsed = tool.input.safeParse(selection.input);
    if (!parsed.success) {
      return abort({
        toolName: tool.name,
        input: selection.input,
        output: null,
        error: `input rejected by the ${tool.name} schema: ${zodIssues(parsed.error.issues)}`,
        tier: tool.tier,
        idempotencyKey,
        effect: 'none',
      });
    }

    if (alreadySucceeded(state.toolOutputs, tool.name, parsed.data)) {
      // Not a call, so not a tool output: the trajectory records what ran.
      // The attribute is how a recording tells a loop the guard ended from
      // one the model ended (P4-C's risk on the prompt fix).
      span.setAttribute('tool.duplicate_suppressed', true);
      return { shouldContinue: false, stepCount, tokenCounts };
    }

    if (tool.tier === 'irreversible') {
      return abort({
        toolName: tool.name,
        input: parsed.data,
        output: null,
        error: 'irreversible tool requires an approval, and this graph has no gate to ask for one',
        tier: tool.tier,
        idempotencyKey,
        effect: 'none',
      });
    }

    const output = await runTool(tool, parsed.data, { runId: state.runId, idempotencyKey });
    if (output.error !== undefined) return abort(output);

    return {
      toolOutputs: [...state.toolOutputs, output],
      stepCount,
      shouldContinue: stepCount < state.maxSteps,
      tokenCounts,
    };
  });
}

/**
 * Executes one validated call inside its `execute_tool` span and records it.
 *
 * A throw is recorded rather than rethrown: a tool failure is a failed step,
 * which aborts the loop and runs the compensations, and is not a transient
 * fault for `IO_RETRY` to repeat. A tool that throws is taken to have applied
 * nothing — the contract a compensable tool's idempotency key makes possible.
 */
export async function runTool(
  tool: ToolDefinition,
  input: ToolArgs,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const recorded = {
    toolName: tool.name,
    input,
    tier: tool.tier,
    idempotencyKey: ctx.idempotencyKey,
  };

  try {
    // Its own span, named before the call, so a tool that throws still says
    // which tool it was. The input and the output are content and stay off it.
    const output = await withToolSpan(tool.name, (span) => {
      span.setAttribute('tool.tier', tool.tier);
      return tool.execute(input, ctx);
    });
    return { ...recorded, output, effect: tool.tier === 'compensable' ? 'applied' : 'none' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...recorded, output: null, error, effect: 'none' };
  }
}

function alreadySucceeded(
  outputs: readonly ToolOutput[],
  toolName: string,
  input: unknown,
): boolean {
  const key = canonicalJson(input);
  return outputs.some(
    (output) =>
      output.error === undefined &&
      output.toolName === toolName &&
      canonicalJson(output.input) === key,
  );
}

function zodIssues(issues: readonly { path: (string | number)[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}

/**
 * JSON with object keys sorted, so `{ a, b }` and `{ b, a }` are one input.
 * The cassette package has its own, and graph code does not import it.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
