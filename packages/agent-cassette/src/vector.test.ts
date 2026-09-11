import { describe, expect, it } from 'vitest';
import { decodeFloat32Base64, encodeFloat32Base64, isNumberVector } from './vector.js';

/** 768 is `semantic_facts.embedding`'s width, so it is the width that matters. */
function embedding(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) / Math.sqrt(768));
}

describe('the float32 vector codec', () => {
  it('round-trips through base64 with equality', () => {
    const original = embedding(1);
    const decoded = decodeFloat32Base64(encodeFloat32Base64(original));

    // Equality is against the float32 projection, which is the value pgvector
    // would have stored: `vector` is an array of `float4`, so the cassette
    // loses nothing the database would not have lost on the way in.
    expect(decoded).toEqual(Array.from(Float32Array.from(original)));
    expect(decoded).toHaveLength(768);
  });

  it('round-trips a Float32Array unchanged, value for value', () => {
    const original = Float32Array.from(embedding(2));

    expect(decodeFloat32Base64(encodeFloat32Base64(original))).toEqual(Array.from(original));
  });

  it('is a quarter of the bytes a JSON float array costs', () => {
    const original = embedding(3);

    expect(encodeFloat32Base64(original)).toHaveLength(4096);
    expect(JSON.stringify(original).length).toBeGreaterThan(15_000);
  });

  it('handles the empty vector', () => {
    expect(decodeFloat32Base64(encodeFloat32Base64([]))).toEqual([]);
  });

  it('refuses a payload that is not a whole number of float32 values', () => {
    expect(() => decodeFloat32Base64(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(
      RangeError,
    );
  });
});

describe('isNumberVector', () => {
  it('accepts a number array and rejects anything else', () => {
    expect(isNumberVector([1, 2, 3])).toBe(true);
    expect(isNumberVector(['1'])).toBe(false);
    expect(isNumberVector({ length: 3 })).toBe(false);
  });
});
