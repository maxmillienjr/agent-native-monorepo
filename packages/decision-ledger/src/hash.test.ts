import { describe, expect, it } from 'vitest';
import { GENESIS_PREV_HASH, commitmentOf, entryHashOf, newSalt } from './hash.js';
import { uuidV5 } from './signature.js';

describe('the commitment', () => {
  it('is SHA-256 over the salt and then the payload', () => {
    const salt = Buffer.alloc(16, 1);
    // Two different salts over one short payload give unrelated commitments:
    // the payload cannot be found by hashing candidates without the salt.
    expect(commitmentOf(salt, '{"a":1}')).not.toBe(commitmentOf(Buffer.alloc(16, 2), '{"a":1}'));
    expect(commitmentOf(salt, '{"a":1}')).toBe(commitmentOf(Buffer.alloc(16, 1), '{"a":1}'));
    expect(commitmentOf(salt, '{"a":1}')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a salt that is not 16 bytes', () => {
    expect(() => commitmentOf(Buffer.alloc(8), 'x')).toThrow(RangeError);
    expect(newSalt()).toHaveLength(16);
  });
});

describe('the entry hash', () => {
  const fields = {
    seq: 0,
    entryId: '00000000-0000-4000-8000-000000000001',
    kind: 'run.recorded',
    recordedAt: '2026-10-08T12:00:00.000Z',
    prevHash: GENESIS_PREV_HASH,
    commitment: 'cd'.repeat(32),
  };

  it('covers every field but itself', () => {
    const base = entryHashOf(fields);
    for (const [key, value] of Object.entries({
      seq: 1,
      entryId: '00000000-0000-4000-8000-000000000002',
      kind: 'disposition.recommended',
      recordedAt: '2026-10-08T12:00:00.001Z',
      prevHash: 'ef'.repeat(32),
      commitment: 'ce'.repeat(32),
    })) {
      expect(entryHashOf({ ...fields, [key]: value }), key).not.toBe(base);
    }
  });
});

describe('uuidV5', () => {
  it('matches RFC 9562 Appendix A.4', () => {
    // The DNS namespace and www.example.com, the RFC's own example.
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('derives one id per name in the ledger namespace', () => {
    const run = '00000000-0000-4000-8000-000000000001';
    expect(uuidV5(`${run}\nrun`)).toBe(uuidV5(`${run}\nrun`));
    expect(uuidV5(`${run}\nrun`)).not.toBe(uuidV5(`${run}\ndisposition`));
  });
});
