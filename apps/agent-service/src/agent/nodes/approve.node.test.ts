import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Command, MemorySaver } from '@langchain/langgraph';
import { buildAgentGraph, type GraphDeps } from '../graph/graph.js';
import { runBody, scriptedDeps } from '../graph/fake-deps.js';
import type { AgentState } from '../graph/state.js';
import { SyntheticCaseBoard } from '../tools/case-board.js';
import { defaultRegistry, defineRegistry } from '../tools/registry.js';
import type { ToolSelection } from '../tools/selection.js';
import { defineTool, type ToolContext } from '../tools/types.js';
import { NO_CHECKPOINTER_REFUSAL } from './act.node.js';

const RUN_ID = '550e8400-e29b-41d4-a716-446655440030';
const config = { configurable: { thread_id: RUN_ID } };

/**
 * The only irreversible tool in the repository, and a test fixture: nothing in
 * the production registry can pause a run.
 */
function withIrreversible() {
  const board = new SyntheticCaseBoard();
  const execute = vi.fn(async (input: { caseId: string }, _ctx: ToolContext) => ({
    sent: input.caseId,
  }));
  const notify = defineTool({
    name: 'notify-member',
    description: 'Fixture: sends a letter to the member on a case. A sent letter cannot be unsent.',
    tier: 'irreversible',
    input: z.object({ caseId: z.string() }).strict(),
    execute,
  });
  const registry = defineRegistry([...defaultRegistry(board).tools, notify]);
  return { board, execute, registry };
}

const notify: ToolSelection = { toolName: 'notify-member', input: { caseId: 'PA-100001' } };
const records: ToolSelection = {
  toolName: 'request-records',
  input: { caseId: 'PA-100001', documents: ['treatment-plan'], dueInDays: 3 },
};

const graph = (deps: GraphDeps, checkpointer?: MemorySaver) =>
  buildAgentGraph(deps, runBody(), 'corr-approve', checkpointer);

const resume = (deps: GraphDeps, checkpointer: MemorySaver, decision: unknown) =>
  graph(deps, checkpointer).invoke(new Command({ resume: decision }), config) as Promise<
    AgentState & { __interrupt__?: unknown[] }
  >;

describe('the approval gate', () => {
  it('pauses before an irreversible call, with execute called zero times', async () => {
    const { execute, registry } = withIrreversible();
    const checkpointer = new MemorySaver();
    const { deps } = scriptedDeps(registry, [notify]);

    const paused = (await graph(deps, checkpointer).invoke({ runId: RUN_ID }, config)) as {
      __interrupt__?: { value: unknown }[];
    };

    expect(execute).not.toHaveBeenCalled();
    expect(paused.__interrupt__?.[0]?.value).toEqual({
      toolName: 'notify-member',
      input: { caseId: 'PA-100001' },
      tier: 'irreversible',
      idempotencyKey: `${RUN_ID}:0`,
    });
    const state = await graph(deps, checkpointer).getState(config);
    expect(state.next).toEqual(['approve']);
  });

  it('executes the call exactly once when resumed with an approval, and records the approver', async () => {
    const { execute, registry } = withIrreversible();
    const checkpointer = new MemorySaver();
    const { deps } = scriptedDeps(registry, [notify, null]);
    await graph(deps, checkpointer).invoke({ runId: RUN_ID }, config);

    const done = await resume(deps, checkpointer, { approved: true, approver: 'reviewer-7' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1]).toEqual({ runId: RUN_ID, idempotencyKey: `${RUN_ID}:0` });
    expect(done.toolOutputs).toMatchObject([
      { toolName: 'notify-member', output: { sent: 'PA-100001' }, approver: 'reviewer-7' },
    ]);
    expect(done.outcome).toBe('success');
    expect(done.pendingApproval).toBeNull();
  });

  it('executes nothing on a rejection, and compensates the effect applied before it', async () => {
    const { board, execute, registry } = withIrreversible();
    const checkpointer = new MemorySaver();
    const { deps } = scriptedDeps(registry, [records, notify]);
    await graph(deps, checkpointer).invoke({ runId: RUN_ID }, config);
    expect(board.openRequests('PA-100001')).toHaveLength(1);

    const done = await resume(deps, checkpointer, { approved: false, approver: 'reviewer-7' });

    expect(execute).not.toHaveBeenCalled();
    expect(board.openRequests('PA-100001')).toEqual([]);
    expect(
      done.toolOutputs.map((output) => [output.toolName, output.effect, output.error]),
    ).toEqual([
      ['request-records', 'compensated', undefined],
      ['notify-member', 'none', 'approval rejected by reviewer-7'],
    ]);
    expect(done.outcome).toBe('partial');
  });

  it('refuses a resume that is not a decision and stays paused', async () => {
    const { execute, registry } = withIrreversible();
    const checkpointer = new MemorySaver();
    const { deps } = scriptedDeps(registry, [notify]);
    await graph(deps, checkpointer).invoke({ runId: RUN_ID }, config);

    // `approved: 'yes'` and no approver: LangGraph 1.4's `responseSchema`
    // parses the resume value and throws before the node reads it.
    await expect(resume(deps, checkpointer, { approved: 'yes' })).rejects.toThrow(z.ZodError);

    expect(execute).not.toHaveBeenCalled();
    expect((await graph(deps, checkpointer).getState(config)).next).toEqual(['approve']);
  });

  it('refuses the call when compiled without a checkpointer, and executes nothing', async () => {
    const { execute, registry } = withIrreversible();
    const { deps } = scriptedDeps(registry, [notify]);

    const done = (await graph(deps).invoke({ runId: RUN_ID })) as AgentState;

    expect(execute).not.toHaveBeenCalled();
    expect(done.toolOutputs.map((output) => output.error)).toEqual([NO_CHECKPOINTER_REFUSAL]);
    expect(done.outcome).toBe('partial');
  });
});
