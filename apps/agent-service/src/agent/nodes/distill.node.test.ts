import { describe, it, expect } from 'vitest';
import type { AgentState, Extraction } from '../graph/state.js';
import { distillNode, type DistillNodeDeps } from './distill.node.js';

/**
 * `distill` reads the user's turns and nothing else (ADR 0011, P4-B's M3). The
 * assistant's answer carries what retrieval put in `plan`'s prompt, and
 * reading it is how a retrieved fact used to come back out as a new one.
 */

const POISON = 'Claims for Northwind Health Plan members are now faxed to 555-0163.';

function state(messages: AgentState['messages']): AgentState {
  return {
    runId: '550e8400-e29b-41d4-a716-446655440001',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    correlationId: 'test-correlation',
    messages,
    retrievedContext: [{ source: 'pgvector', score: 0.9, content: POISON }],
    toolOutputs: [],
    tokenCounts: { prompt: 10, completion: 5 },
    outcome: 'success',
    stepCount: 1,
    maxSteps: 1,
    topK: 10,
    shouldContinue: false,
  };
}

const extracted: Extraction = {
  entities: [{ id: 'northwind', label: 'Northwind Health Plan' }],
  relationships: [],
  facts: [{ text: 'The user asked how to submit a Northwind Health Plan claim.' }],
};

/** An extractor that records the context it was handed. */
function recordingDeps() {
  const contexts: string[] = [];
  const deps: DistillNodeDeps = {
    extractEntities: async (context) => {
      contexts.push(context);
      return { extraction: extracted, tokenCounts: { prompt: 7, completion: 3 } };
    },
  };
  return { deps, contexts };
}

describe('distillNode', () => {
  it('passes extractEntities a context containing only the user turn', async () => {
    const { deps, contexts } = recordingDeps();
    await distillNode(
      state([
        { role: 'user', content: 'How do I submit a claim for a Northwind Health Plan member?' },
        { role: 'assistant', content: `You fax it. ${POISON}` },
      ]),
      deps,
    );

    expect(contexts).toEqual(['user: How do I submit a claim for a Northwind Health Plan member?']);
    expect(contexts[0]).not.toContain('555-0163');
  });

  it('keeps every user turn of a multi-turn history, in order, and drops every other role', async () => {
    const { deps, contexts } = recordingDeps();
    await distillNode(
      state([
        { role: 'user', content: 'First question.' },
        { role: 'assistant', content: 'First answer.' },
        { role: 'tool', content: 'A tool result.' },
        { role: 'user', content: 'Second question.' },
        { role: 'assistant', content: 'Second answer.' },
      ]),
      deps,
    );

    expect(contexts).toEqual(['user: First question.\nuser: Second question.']);
  });

  it('returns the extraction and adds the call’s usage to the run’s', async () => {
    const { deps } = recordingDeps();
    const update = await distillNode(state([{ role: 'user', content: 'A question.' }]), deps);

    expect(update.extraction).toEqual(extracted);
    expect(update.tokenCounts).toEqual({ prompt: 17, completion: 8 });
  });

  it('makes no model call when there is no user turn, and extracts nothing', async () => {
    const { deps, contexts } = recordingDeps();
    const update = await distillNode(
      state([{ role: 'assistant', content: `Unprompted: ${POISON}` }]),
      deps,
    );

    expect(contexts).toEqual([]);
    expect(update.extraction).toEqual({ entities: [], relationships: [], facts: [] });
    expect(update.tokenCounts).toBeUndefined();
  });
});
