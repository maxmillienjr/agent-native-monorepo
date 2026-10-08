import { describe, expect, it } from 'vitest';
import { CassetteSchema, SEAMS, requestHash } from '@repo/agent-cassette';
import { RECORD_SEAMS, RunDecisionSchema } from './run-record.js';

const RETRIEVAL = {
  seam: 'memory.retrieve',
  requestHash: requestHash({ seam: 'memory.retrieve', request: { topK: 10 } }),
  request: { topK: 10 },
  response: { kind: 'value', value: [] },
  latencyMs: 3,
};

const HEADER = {
  formatVersion: 2,
  taskId: 'memory-recall-001',
  trialIndex: 0,
  recordedAt: '2026-10-08T00:00:00.000Z',
  gitSha: 'a'.repeat(40),
  axes: { model: 'live', memory: 'live' },
  chatModel: 'gemini-2.5-flash',
  embeddingModel: 'gemini-embedding-001',
  embeddingDimensions: 768,
};

describe('the run record seam', () => {
  it('is the cassette’s seams plus memory.retrieve, which the cassette does not have', () => {
    expect(SEAMS).not.toContain('memory.retrieve');
    expect(RECORD_SEAMS).toEqual([...SEAMS, 'memory.retrieve']);
  });

  it('rejects a memory.retrieve decision in a cassette and accepts it in a run record', () => {
    // ADR 0005: evaluation replays the model axis and keeps memory live, so a
    // cassette that could hold a retrieval would be one that skips the store.
    expect(CassetteSchema.safeParse({ header: HEADER, decisions: [RETRIEVAL] }).success).toBe(
      false,
    );
    expect(RunDecisionSchema.parse(RETRIEVAL).seam).toBe('memory.retrieve');
  });

  it('still rejects a seam neither of them names', () => {
    expect(RunDecisionSchema.safeParse({ ...RETRIEVAL, seam: 'memory.write' }).success).toBe(false);
  });
});
