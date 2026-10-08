import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CassetteSchema, encodeFloat32Base64, type Cassette } from '@repo/agent-cassette';
import { cassettePath } from '@repo/eval-harness';
import {
  compareCassettes,
  compareDirectories,
  renderComparisonSummary,
} from './compare-cassettes.js';

/** Fixture cassettes: `[seam, key, response]`, where the key stands in for the request hash. */
type Step =
  | readonly ['embed', string, readonly number[]]
  | readonly ['act.selectTool', string, string | null]
  | readonly ['plan.callLlm' | 'distill.extractEntities' | 'act.tool', string, unknown];

const hash = (key: string): string => key.padEnd(64, '0').slice(0, 64);

function cassette(
  taskId: string,
  steps: readonly Step[],
  chatModel = 'gemini-2.5-flash',
): Cassette {
  return CassetteSchema.parse({
    header: {
      formatVersion: 1,
      taskId,
      trialIndex: 0,
      recordedAt: '2026-10-08T03:00:00.000Z',
      gitSha: 'f'.repeat(40),
      axes: { model: 'live', memory: 'live' },
      chatModel,
      embeddingModel: 'gemini-embedding-001',
      embeddingDimensions: 4,
    },
    decisions: steps.map(([seam, key, response]) => ({
      seam,
      requestHash: hash(key),
      request: {},
      response:
        seam === 'embed'
          ? { kind: 'vector', float32Base64: encodeFloat32Base64(response as number[]) }
          : seam === 'act.selectTool'
            ? { kind: 'value', value: response === null ? null : { toolName: response, input: {} } }
            : { kind: 'value', value: response },
      latencyMs: 1,
    })),
  });
}

const QUESTION = [0.5, 0.5, 0.5, 0.5] as const;

describe('compareCassettes', () => {
  it('counts a shared embed that came back bit-identical', () => {
    const committed = cassette('t', [
      ['embed', 'aa', QUESTION],
      ['plan.callLlm', 'bb', 'plan'],
    ]);
    const live = cassette('t', [
      ['embed', 'aa', QUESTION],
      ['plan.callLlm', 'bb', 'other text'],
    ]);

    const comparison = compareCassettes(committed, live);
    expect(comparison.sharedEmbeds).toEqual({ count: 1, identical: 1, minCosine: 1 });
    // The plan's text differs and its request does not: that is sampling, not drift.
    expect(comparison.firstDivergence).toBeNull();
  });

  it('reports a shared embed that differs, with its cosine', () => {
    const committed = cassette('t', [['embed', 'aa', QUESTION]]);
    const live = cassette('t', [['embed', 'aa', [0.5, 0.5, 0.5, 0.6]]]);

    const { sharedEmbeds } = compareCassettes(committed, live);
    expect(sharedEmbeds.count).toBe(1);
    expect(sharedEmbeds.identical).toBe(0);
    expect(sharedEmbeds.minCosine).toBeGreaterThan(0.99);
    expect(sharedEmbeds.minCosine).toBeLessThan(1);
  });

  it('finds the first live decision the committed trial lacks, by seam and position', () => {
    const committed = cassette('t', [
      ['embed', 'aa', QUESTION],
      ['plan.callLlm', 'bb', 'plan'],
      ['distill.extractEntities', 'cc', {}],
      ['embed', 'dd', QUESTION],
    ]);
    const live = cassette('t', [
      ['embed', 'aa', QUESTION],
      ['plan.callLlm', 'bb', 'plan'],
      ['distill.extractEntities', 'c2', {}],
      ['embed', 'd2', QUESTION],
    ]);

    const comparison = compareCassettes(committed, live);
    expect(comparison.firstDivergence).toEqual({ seam: 'distill.extractEntities', index: 2 });
    // An embed of a text only one side asked for is not shared.
    expect(comparison.sharedEmbeds.count).toBe(1);
  });

  it('lists the tools each side chose, so a changed sequence is visible', () => {
    const committed = cassette('t', [
      ['act.selectTool', 's1', 'web-search'],
      ['act.selectTool', 's2', 'web-search'],
    ]);
    const live = cassette('t', [
      ['act.selectTool', 's1', 'web-search'],
      ['act.selectTool', 's3', null],
    ]);

    const comparison = compareCassettes(committed, live);
    expect(comparison.tools).toEqual({
      committed: ['web-search', 'web-search'],
      live: ['web-search', null],
    });
    expect(comparison.firstDivergence).toEqual({ seam: 'act.selectTool', index: 1 });

    const summary = renderComparisonSummary([comparison], {
      chatModels: ['gemini-2.5-flash'],
      missing: [],
    });
    expect(summary).toContain('| web-search → web-search | web-search → none |');
  });
});

describe('compareDirectories', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it('pairs each live trial with the committed one, falling back to trial 0, and names the rest', () => {
    root = mkdtempSync(join(tmpdir(), 'compare-'));
    const dataset = join(root, 'dataset');
    const liveDir = join(root, 'live');
    mkdirSync(liveDir, { recursive: true });

    const committedPath = cassettePath(dataset, 'memory-recall-001', 0);
    mkdirSync(dirname(committedPath), { recursive: true });
    writeFileSync(
      committedPath,
      JSON.stringify(cassette('memory-recall-001', [['embed', 'aa', QUESTION]])),
    );

    const second = cassette(
      'memory-recall-001',
      [['embed', 'aa', QUESTION]],
      'gemini-flash-latest',
    );
    writeFileSync(
      join(liveDir, 'memory-recall-001.trial-1.json'),
      JSON.stringify({ ...second, header: { ...second.header, trialIndex: 1 } }),
    );
    writeFileSync(
      join(liveDir, 'graph-recall-001.trial-0.json'),
      JSON.stringify(cassette('graph-recall-001', [['embed', 'zz', QUESTION]])),
    );

    const result = compareDirectories(liveDir, dataset);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({ taskId: 'memory-recall-001', trialIndex: 1 });
    expect(result.comparisons[0]!.sharedEmbeds.identical).toBe(1);
    expect(result.missing).toEqual(['graph-recall-001.trial-0.json']);
    expect(result.chatModels).toEqual(['gemini-2.5-flash', 'gemini-flash-latest']);
  });
});
