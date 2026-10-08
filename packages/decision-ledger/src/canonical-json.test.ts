import { describe, expect, it } from 'vitest';
import { canonicalJson as cassetteCanonicalJson } from '@repo/agent-cassette';
import { canonicalJson } from './canonical-json.js';

/**
 * The copy and the original, over one corpus. A reviewer signs the cassette's
 * bytes (P3-E's `signature.ts`), and the ledger verifies with its own copy, so
 * a difference here is a valid signature the ledger would refuse.
 */
const CORPUS: readonly unknown[] = [
  null,
  true,
  0,
  -1.5,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  '',
  'naïve "quoted" \\ \n line',
  '   and an emoji 🧾',
  [],
  [1, undefined, () => 1, Symbol('s'), null],
  {},
  { b: 1, a: 2, c: { z: [3, { y: 1, x: 2 }], a: undefined } },
  { toJSON: () => ({ replaced: true }) },
  new Date('2026-10-08T12:00:00.000Z'),
  {
    determination: {
      kind: 'denial',
      specificReason: 'Synthetic: the record does not document the criterion.',
      attestation: {
        reviewerId: 'synthetic-reviewer-001',
        credential: { type: 'MD', jurisdiction: 'US-XX' },
        attestedAt: '2026-10-08T12:00:00.000Z',
      },
    },
    recommendationSeq: 3,
    runId: '00000000-0000-4000-8000-000000000001',
  },
  { kind: 'run.recorded', runDigest: 'a'.repeat(64), outcome: null, decisionCount: 6 },
];

describe('canonicalJson', () => {
  it.each(CORPUS.map((value, index) => [index, value] as const))(
    'matches @repo/agent-cassette byte for byte on corpus item %i',
    (_index, value) => {
      expect(canonicalJson(value)).toBe(cassetteCanonicalJson(value));
    },
  );

  it('refuses a bigint, as the original does', () => {
    expect(() => canonicalJson(1n)).toThrow(TypeError);
    expect(() => cassetteCanonicalJson(1n)).toThrow(TypeError);
  });
});
