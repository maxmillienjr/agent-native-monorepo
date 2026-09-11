import { describe, expect, it } from 'vitest';
import { canonicalJson, decisionKey, requestHash } from './hash.js';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });

    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('preserves array order, which is meaning rather than layout', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('follows JSON on undefined: dropped in objects, null in arrays', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });

  it('refuses a bigint rather than guessing a representation', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });
});

describe('requestHash', () => {
  it('is stable across key order in the request', () => {
    const first = requestHash({ seam: 'plan.callLlm', request: { system: 's', user: 'u' } });
    const second = requestHash({ seam: 'plan.callLlm', request: { user: 'u', system: 's' } });

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it('separates two seams that happen to share a request shape', () => {
    const plan = requestHash({ seam: 'plan.callLlm', request: { text: 'x' } });
    const distill = requestHash({ seam: 'distill.extractEntities', request: { text: 'x' } });

    expect(plan).not.toBe(distill);
  });

  it('separates two tools called with the same input', () => {
    const upper = requestHash({ seam: 'act.tool', label: 'uppercase', request: { input: 'x' } });
    const reverse = requestHash({ seam: 'act.tool', label: 'reverse', request: { input: 'x' } });

    expect(upper).not.toBe(reverse);
  });

  it('moves when the prompt moves, which is what makes a prompt edit a miss', () => {
    const before = requestHash({ seam: 'plan.callLlm', request: { system: 'You are.' } });
    const after = requestHash({ seam: 'plan.callLlm', request: { system: 'You are helpful.' } });

    expect(before).not.toBe(after);
  });
});

describe('decisionKey', () => {
  it('is one queue per seam, label and hash', () => {
    expect(decisionKey('act.tool', 'uppercase', 'a'.repeat(64))).not.toBe(
      decisionKey('act.tool', undefined, 'a'.repeat(64)),
    );
  });
});
