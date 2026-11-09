import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestHash } from '@repo/agent-cassette';
import type { EvidenceItem, PolicyCriterion } from '@repo/prior-auth';
import type { ToolSelectionRequest } from '../tools/selection.js';

/**
 * Each JSON seam hashes its instruction (P1-I, cassette format 3).
 *
 * `distill.extractEntities`, `act.selectTool` and `assess.criteria` read their
 * instruction from a module constant rather than an argument, so before format
 * 3 a reworded instruction left every hash where it was and replayed the old
 * answers. Each case here loads `decision-seam.ts` twice, once over the real
 * prompt module and once over a copy whose one constant is reworded, and
 * compares the hash of the same call. A seam that stopped carrying its
 * instruction would hash the same under both, and fail here rather than in a
 * replay that silently passes.
 */

const SELECTION: ToolSelectionRequest = { plan: 'a plan', tools: [], previous: [] };
const CRITERIA: PolicyCriterion[] = [
  { id: 'c1', title: 'A criterion', requirement: 'A requirement.' },
];
const EVIDENCE: EvidenceItem[] = [
  { reference: 'DocumentReference/doc-1', text: 'A synthetic note.' },
];

/** The three seams' hashes, with the given prompt module's constant replaced. */
async function hashesWith(replace?: {
  module: string;
  name: string;
}): Promise<Record<'extract' | 'selectTool' | 'assess', string>> {
  vi.resetModules();
  if (replace !== undefined) {
    vi.doMock(replace.module, async (original) => {
      const actual = await original<Record<string, unknown>>();
      return { ...actual, [replace.name]: `${String(actual[replace.name])}\nA reworded line.` };
    });
  }
  const { calls } = await import('./decision-seam.js');
  return {
    extract: requestHash(calls.extract('a conversation')),
    selectTool: requestHash(calls.selectTool(SELECTION)),
    assess: requestHash(calls.assess(CRITERIA, EVIDENCE)),
  };
}

describe('a JSON seam whose instruction is reworded', () => {
  afterEach(() => {
    vi.doUnmock('./extraction.js');
    vi.doUnmock('../tools/selection.js');
    vi.doUnmock('../prior-auth/assessment.js');
    vi.resetModules();
  });

  it.each([
    { seam: 'extract', module: './extraction.js', name: 'EXTRACTION_PROMPT' },
    { seam: 'selectTool', module: '../tools/selection.js', name: 'SELECT_TOOL_PROMPT' },
    { seam: 'assess', module: '../prior-auth/assessment.js', name: 'ASSESS_PROMPT' },
  ] as const)('$name moves the $seam hash, and only that one', async ({ seam, module, name }) => {
    const before = await hashesWith();
    const after = await hashesWith({ module, name });

    expect(after[seam]).not.toBe(before[seam]);
    // The other two seams do not read this constant, so their hashes stay.
    for (const other of ['extract', 'selectTool', 'assess'] as const) {
      if (other !== seam) expect(after[other]).toBe(before[other]);
    }
  });

  it('is stable when nothing is reworded', async () => {
    expect(await hashesWith()).toEqual(await hashesWith());
  });
});
