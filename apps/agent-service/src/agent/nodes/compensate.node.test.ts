import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph';
import { buildAgentGraph, type GraphDeps } from '../graph/graph.js';
import { runBody, scriptedDeps } from '../graph/fake-deps.js';
import type { AgentState } from '../graph/state.js';
import { SyntheticCaseBoard } from '../tools/case-board.js';
import { defaultRegistry, defineRegistry } from '../tools/registry.js';
import type { ToolSelection } from '../tools/selection.js';
import { defineTool } from '../tools/types.js';

const RUN_ID = '550e8400-e29b-41d4-a716-446655440020';
const config = { configurable: { thread_id: RUN_ID } };

const records = (caseId: string): ToolSelection => ({
  toolName: 'request-records',
  input: { caseId, documents: ['clinical-notes'], dueInDays: 7 },
});

/** The node sequence and the final state, folded from the stream as `executeTraced` does. */
async function traced(
  deps: GraphDeps,
  checkpointer?: MemorySaver,
): Promise<{ nodes: string[]; state: AgentState }> {
  const compiled = buildAgentGraph(deps, runBody(), 'corr-saga', checkpointer);
  const nodes: string[] = [];
  const state: Record<string, unknown> = { runId: RUN_ID };
  for await (const chunk of await compiled.stream({ runId: RUN_ID }, config)) {
    for (const [node, update] of Object.entries(chunk)) {
      nodes.push(node);
      Object.assign(state, update);
    }
  }
  return { nodes, state: state as unknown as AgentState };
}

/**
 * A compensable tool that logs its undo and fails it `failures` times first,
 * and a tool that always throws, to fail a step on demand.
 */
function sagaRegistry(log: string[], failures: Record<string, number> = {}) {
  const step = (name: string) =>
    defineTool({
      name,
      description: `Opens a fixture effect named ${name}, and is compensated by closing it again.`,
      tier: 'compensable',
      input: z.object({ n: z.number() }).strict(),
      execute: async ({ n }) => ({ opened: `${name}-${n}` }),
      compensate: async (_input, output) => {
        if ((failures[name] ?? 0) > 0) {
          failures[name] = (failures[name] ?? 0) - 1;
          throw new Error(`ECONNRESET while closing ${output.opened}`);
        }
        log.push(output.opened);
      },
    });
  const broken = defineTool({
    name: 'broken-step',
    description: 'Fails every time it runs, so a test can fail the step after the effects.',
    tier: 'read-only',
    input: z.object({}).strict(),
    execute: async () => {
      throw new Error('the downstream system refused the call');
    },
  });
  return defineRegistry([step('open-a'), step('open-b'), broken]);
}

describe('the saga', () => {
  it('withdraws the first request exactly once when a second names an unknown case', async () => {
    const board = new SyntheticCaseBoard();
    const withdraw = vi.spyOn(board, 'withdrawRequest');
    const { deps } = scriptedDeps(defaultRegistry(board), [
      records('PA-100001'),
      records('PA-999999'),
    ]);

    const { nodes, state } = await traced(deps);

    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw).toHaveBeenCalledWith('RR-000001', `${RUN_ID}:0`);
    expect(board.openRequests('PA-100001')).toEqual([]);
    expect(nodes).toEqual([
      'ingress',
      'retrieve',
      'plan',
      'act',
      'act',
      'compensate',
      'distill',
      'reflect',
      'egress',
    ]);
    expect(state.toolOutputs.map((output) => [output.effect, output.error])).toEqual([
      ['compensated', undefined],
      ['none', 'no case PA-999999 on the board'],
    ]);
    expect(state.outcome).toBe('partial');
  });

  it('compensates two applied effects in reverse order', async () => {
    const log: string[] = [];
    const { deps } = scriptedDeps(sagaRegistry(log), [
      { toolName: 'open-a', input: { n: 1 } },
      { toolName: 'open-b', input: { n: 2 } },
      { toolName: 'broken-step', input: {} },
    ]);

    const { nodes, state } = await traced(deps);

    expect(log).toEqual(['open-b-2', 'open-a-1']);
    expect(nodes.filter((node) => node === 'compensate')).toHaveLength(2);
    expect(state.toolOutputs.map((output) => output.effect)).toEqual([
      'compensated',
      'compensated',
      'none',
    ]);
    expect(state.outcome).toBe('partial');
  });

  it('leaves a run that finished cleanly with its effects applied', async () => {
    const log: string[] = [];
    const { deps } = scriptedDeps(sagaRegistry(log), [{ toolName: 'open-a', input: { n: 1 } }]);

    const { nodes, state } = await traced(deps);

    expect(log).toEqual([]);
    expect(nodes).not.toContain('compensate');
    expect(state.toolOutputs[0]!.effect).toBe('applied');
    expect(state.outcome).toBe('success');
  });

  it('retries a compensation that fails twice, and does not undo an effect already marked', async () => {
    const log: string[] = [];
    const { deps } = scriptedDeps(sagaRegistry(log, { 'open-a': 2 }), [
      { toolName: 'open-a', input: { n: 1 } },
      { toolName: 'open-b', input: { n: 2 } },
      { toolName: 'broken-step', input: {} },
    ]);

    const { state } = await traced(deps);

    // open-b was undone on the first pass and marked; the second pass, whose
    // first two attempts failed on open-a, did not undo it again.
    expect(log).toEqual(['open-b-2', 'open-a-1']);
    expect(state.toolOutputs.map((output) => output.effect)).toEqual([
      'compensated',
      'compensated',
      'none',
    ]);
  }, 20_000);

  it('fails the run on a compensation that never succeeds, with a checkpoint that says what was undone', async () => {
    const log: string[] = [];
    const checkpointer = new MemorySaver();
    const script = [
      { toolName: 'open-a', input: { n: 1 } },
      { toolName: 'open-b', input: { n: 2 } },
      { toolName: 'broken-step', input: {} },
    ];
    const failing = scriptedDeps(sagaRegistry(log, { 'open-a': Infinity }), script);

    await expect(traced(failing.deps, checkpointer)).rejects.toThrow('ECONNRESET');

    const stopped = await buildAgentGraph(
      failing.deps,
      runBody(),
      'corr-saga',
      checkpointer,
    ).getState(config);
    const effects = (stopped.values as AgentState).toolOutputs.map((output) => output.effect);
    expect(effects).toEqual(['applied', 'compensated', 'none']);
    expect(stopped.next).toEqual(['compensate']);

    // Resumed once the system is back: open-b stays compensated and is not
    // undone a second time.
    const recovered = scriptedDeps(sagaRegistry(log), []);
    const resumed = await buildAgentGraph(
      recovered.deps,
      runBody(),
      'corr-saga',
      checkpointer,
    ).invoke(null, config);
    expect(log).toEqual(['open-b-2', 'open-a-1']);
    expect((resumed as unknown as AgentState).outcome).toBe('partial');
  }, 20_000);
});
