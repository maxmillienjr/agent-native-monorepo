import { describe, it, expect } from 'vitest';
import { attestAdverseDetermination } from './clinician.js';
import { DeterminationRecordSchema } from './determination.js';
import { SYNTHETIC_ATTESTATION, SYNTHETIC_DENIAL_INPUT } from './fixtures.js';

describe('attestAdverseDetermination', () => {
  it('returns a denial that carries its attestation', () => {
    const denial = attestAdverseDetermination(SYNTHETIC_DENIAL_INPUT, SYNTHETIC_ATTESTATION);
    expect(denial).toEqual({ ...SYNTHETIC_DENIAL_INPUT, attestation: SYNTHETIC_ATTESTATION });
    // A reader validates what the constructor produced without being able to mint one.
    expect(DeterminationRecordSchema.safeParse(denial).success).toBe(true);
  });

  it('rejects an attestedAt that is not an ISO-8601 timestamp', () => {
    expect(() =>
      attestAdverseDetermination(SYNTHETIC_DENIAL_INPUT, {
        ...SYNTHETIC_ATTESTATION,
        attestedAt: '26 September 2026',
      }),
    ).toThrow();
  });

  it('rejects an ISO-8601 attestedAt with no offset', () => {
    expect(() =>
      attestAdverseDetermination(SYNTHETIC_DENIAL_INPUT, {
        ...SYNTHETIC_ATTESTATION,
        attestedAt: '2026-09-26T14:00:00',
      }),
    ).toThrow();
  });

  it('rejects an empty specificReason', () => {
    expect(() =>
      attestAdverseDetermination({ kind: 'denial', specificReason: '' }, SYNTHETIC_ATTESTATION),
    ).toThrow();
  });

  it('rejects an attestation with no reviewer, as JSON off the wire would carry it', () => {
    const fromTheWire = JSON.parse(
      JSON.stringify({ ...SYNTHETIC_ATTESTATION, reviewerId: undefined }),
    ) as typeof SYNTHETIC_ATTESTATION;
    expect(() => attestAdverseDetermination(SYNTHETIC_DENIAL_INPUT, fromTheWire)).toThrow();
  });
});
