import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CassetteSchema, type Cassette } from '@repo/agent-cassette';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@repo/memory-core';
import {
  CANARY_BASELINE_PATH,
  embeddingBaselineFromCassettes,
  loadCanaryBaseline,
} from './baseline.js';

function cassette(taskId: string, embeds: readonly [string, string][]): Cassette {
  return CassetteSchema.parse({
    header: {
      formatVersion: 1,
      taskId,
      trialIndex: 0,
      recordedAt: '2026-09-11T01:48:09.269Z',
      gitSha: '021c6f2ebaa2dd67be605dee45f6ece08bc733c5',
      axes: { model: 'live', memory: 'live' },
      chatModel: 'gemini-2.5-flash',
      embeddingModel: EMBEDDING_MODEL,
      embeddingDimensions: EMBEDDING_DIMENSIONS,
    },
    decisions: [
      {
        seam: 'plan.callLlm',
        requestHash: 'a'.repeat(64),
        request: {},
        response: { kind: 'value', value: 'plan' },
        latencyMs: 1,
      },
      ...embeds.map(([text, vector]) => ({
        seam: 'embed',
        requestHash: 'b'.repeat(64),
        request: { text },
        response: { kind: 'vector', float32Base64: vector },
        latencyMs: 1,
      })),
      {
        seam: 'embed',
        requestHash: 'c'.repeat(64),
        request: { text: 'a failed embed' },
        response: { kind: 'error', name: 'EmbeddingRequestError', message: 'x', status: 500 },
        latencyMs: 1,
      },
    ],
  });
}

describe('embeddingBaselineFromCassettes', () => {
  it('takes every distinct embedded text, in order, with its recorded vector and provenance', () => {
    const baseline = embeddingBaselineFromCassettes(
      [
        cassette('memory-recall-001', [
          ['first', 'AAAA'],
          ['second', 'BBBB'],
        ]),
        cassette('tool-use-001', [
          ['first', 'CCCC'],
          ['third', 'DDDD'],
        ]),
      ],
      '2026-09-11',
    );

    expect(baseline.probes).toEqual([
      { taskId: 'memory-recall-001', text: 'first', float32Base64: 'AAAA' },
      { taskId: 'memory-recall-001', text: 'second', float32Base64: 'BBBB' },
      { taskId: 'tool-use-001', text: 'third', float32Base64: 'DDDD' },
    ]);
    expect(baseline.since).toBe('2026-09-11');
    expect(baseline.source).toContain('021c6f2ebaa2dd67be605dee45f6ece08bc733c5');
  });
});

describe('the committed baseline', () => {
  it('parses, and holds the 21 distinct texts the committed cassettes embedded at 021c6f2', () => {
    const baseline = loadCanaryBaseline(CANARY_BASELINE_PATH);
    expect(baseline.embedding.model).toBe(EMBEDDING_MODEL);
    expect(baseline.embedding.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(baseline.embedding.probes).toHaveLength(21);
    expect(new Set(baseline.embedding.probes.map((probe) => probe.text)).size).toBe(21);
    expect(baseline.embedding.source).toContain('021c6f2ebaa2dd67be605dee45f6ece08bc733c5');
    // Pretty-printed with a trailing newline, as the update command writes it.
    expect(readFileSync(CANARY_BASELINE_PATH, 'utf8').endsWith('}\n')).toBe(true);
  });
});
