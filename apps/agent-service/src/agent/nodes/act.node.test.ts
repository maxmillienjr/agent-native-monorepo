import { describe, it, expect } from 'vitest';
import { buildAgentGraph, type GraphDeps } from '../graph/graph.js';
import { runBody, scriptedDeps } from '../graph/fake-deps.js';
import type { AgentState } from '../graph/state.js';
import { SyntheticCaseBoard } from '../tools/case-board.js';
import { defaultRegistry, defineRegistry } from '../tools/registry.js';
import { parseSelection, SelectionFormatError } from '../tools/selection.js';
import { webSearchTool } from '../tools/web-search.tool.js';

const RUN_ID = '550e8400-e29b-41d4-a716-446655440010';

async function run(deps: GraphDeps, maxSteps = 5): Promise<AgentState> {
  const compiled = buildAgentGraph(deps, runBody(maxSteps), 'corr-act');
  return (await compiled.invoke({ runId: RUN_ID })) as unknown as AgentState;
}

/** web-search with its executions counted. */
function countedSearch() {
  const executed: unknown[] = [];
  const registry = defineRegistry([
    {
      ...webSearchTool,
      execute: async (input: { query: string }) => {
        executed.push(input);
        return { results: [`Result for: ${input.query}`] };
      },
    },
  ]);
  return { registry, executed };
}

describe('the selection request', () => {
  it('carries every tool’s description, tier and JSON schema, and the first call on the second step', async () => {
    const registry = defaultRegistry(new SyntheticCaseBoard());
    const { deps, requests } = scriptedDeps(registry, [
      { toolName: 'web-search', input: { query: 'records request rules' } },
      null,
    ]);

    await run(deps);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools).toEqual(registry.describe());
    expect(requests[0]!.tools.map((tool) => [tool.name, tool.tier])).toEqual([
      ['web-search', 'read-only'],
      ['request-records', 'compensable'],
    ]);
    for (const tool of requests[0]!.tools) {
      expect(tool.description.length).toBeGreaterThanOrEqual(40);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(requests[0]!.previous).toEqual([]);
    expect(requests[1]!.previous).toEqual([
      {
        toolName: 'web-search',
        input: { query: 'records request rules' },
        output: JSON.stringify({ results: ['Result for: {"query":"records request rules"}'] }),
      },
    ]);
  });

  it('cuts a previous output to 2,000 characters', async () => {
    const registry = defineRegistry([
      { ...webSearchTool, execute: async () => ({ results: ['x'.repeat(5000)] }) },
    ]);
    const { deps, requests } = scriptedDeps(registry, [
      { toolName: 'web-search', input: { query: 'long' } },
      null,
    ]);

    await run(deps);

    expect(requests[1]!.previous[0]!.output).toHaveLength(2000);
  });
});

describe('a selection act refuses', () => {
  it('records an input that fails the tool’s schema with the Zod issues, and never executes', async () => {
    const { registry, executed } = countedSearch();
    // The shape one live web-search call had: the query as a bare string.
    const { deps } = scriptedDeps(registry, [
      { toolName: 'web-search', input: 'LangGraph latest release' },
    ]);

    const state = await run(deps);

    expect(executed).toHaveLength(0);
    expect(state.toolOutputs).toHaveLength(1);
    expect(state.toolOutputs[0]!.error).toMatch(
      /^input rejected by the web-search schema: <root>: Expected object, received string$/,
    );
    expect(state.aborted).toBe(true);
    expect(state.outcome).toBe('partial');
  });

  it('records an unknown tool and aborts', async () => {
    const { registry, executed } = countedSearch();
    const { deps } = scriptedDeps(registry, [{ toolName: 'send-fax', input: {} }]);

    const state = await run(deps);

    expect(executed).toHaveLength(0);
    expect(state.toolOutputs.map((output) => output.error)).toEqual(['Tool "send-fax" not found']);
    expect(state.outcome).toBe('partial');
  });

  it('executes a (tool, input) pair once when the model selects it twice, and ends with no error', async () => {
    const { registry, executed } = countedSearch();
    const { deps, requests } = scriptedDeps(registry, [
      { toolName: 'web-search', input: { query: 'LangGraph release' } },
      { toolName: 'web-search', input: { query: 'LangGraph release' } },
      { toolName: 'web-search', input: { query: 'never reached' } },
    ]);

    const state = await run(deps);

    expect(executed).toEqual([{ query: 'LangGraph release' }]);
    expect(requests).toHaveLength(2);
    expect(state.toolOutputs).toHaveLength(1);
    expect(state.toolOutputs.some((output) => output.error !== undefined)).toBe(false);
    expect(state.aborted).toBe(false);
    expect(state.outcome).toBe('success');
  });

  it('keys each step by run and step, and marks only a compensable success applied', async () => {
    const registry = defaultRegistry(new SyntheticCaseBoard());
    const { deps } = scriptedDeps(registry, [
      { toolName: 'web-search', input: { query: 'which documents' } },
      {
        toolName: 'request-records',
        input: { caseId: 'PA-100001', documents: ['lab-results'], dueInDays: 5 },
      },
      null,
    ]);

    const state = await run(deps);

    expect(
      state.toolOutputs.map((output) => [output.toolName, output.idempotencyKey, output.effect]),
    ).toEqual([
      ['web-search', `${RUN_ID}:0`, 'none'],
      ['request-records', `${RUN_ID}:1`, 'applied'],
    ]);
  });
});

describe('parseSelection', () => {
  it('throws SelectionFormatError on a response that is not JSON, rather than reading it as no tool', () => {
    expect(() => parseSelection('```json\n{"toolName": "web-search"}\n```')).toThrow(
      SelectionFormatError,
    );
  });

  it('throws SelectionFormatError on JSON that is not a selection', () => {
    expect(() => parseSelection('{"tool": "web-search"}')).toThrow(SelectionFormatError);
    expect(() => parseSelection('"web-search"')).toThrow(SelectionFormatError);
  });

  it('reads null as no tool, and a selection as given', () => {
    expect(parseSelection('null')).toBeNull();
    expect(parseSelection('{"toolName":"web-search","input":{"query":"q"}}')).toEqual({
      toolName: 'web-search',
      input: { query: 'q' },
    });
  });

  it('is retried by IO_RETRY in the graph, where a null used to end the loop as success', async () => {
    const { registry, executed } = countedSearch();
    const { deps } = scriptedDeps(registry, []);
    let attempts = 0;
    deps.act = {
      registry,
      selectTool: async () => {
        attempts += 1;
        if (attempts === 1)
          return {
            selection: parseSelection('Sure! Here is the tool.'),
            tokenCounts: { prompt: 0, completion: 0 },
          };
        return {
          selection: { toolName: 'web-search', input: { query: 'q' } },
          tokenCounts: { prompt: 0, completion: 0 },
        };
      },
    };

    const state = await run(deps, 1);

    expect(attempts).toBe(2);
    expect(executed).toEqual([{ query: 'q' }]);
    expect(state.outcome).toBe('success');
  });
});
