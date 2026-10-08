import { describe, expect, it } from 'vitest';
import {
  InvolvedReviewerError,
  attestAdverseDetermination,
  attestReconsideration,
} from './clinician.js';
import { ReconsiderationRecordSchema } from './determination.js';
import {
  SYNTHETIC_ATTESTATION,
  SYNTHETIC_DENIAL_INPUT,
  SYNTHETIC_RECONSIDERING_ATTESTATION,
  SYNTHETIC_REVERSAL_INPUT,
} from './fixtures.js';

const denial = attestAdverseDetermination(SYNTHETIC_DENIAL_INPUT, SYNTHETIC_ATTESTATION);

describe('attestReconsideration (P3-F)', () => {
  it('records the initial reviewer from the denial it is given', () => {
    const reconsideration = attestReconsideration(
      denial,
      SYNTHETIC_REVERSAL_INPUT,
      SYNTHETIC_RECONSIDERING_ATTESTATION,
    );
    expect(reconsideration).toEqual({
      ...SYNTHETIC_REVERSAL_INPUT,
      attestation: SYNTHETIC_RECONSIDERING_ATTESTATION,
      initialReviewerId: 'synthetic-reviewer-001',
    });
    expect(ReconsiderationRecordSchema.safeParse(reconsideration).success).toBe(true);
  });

  it('throws InvolvedReviewerError when the attesting reviewer made the denial', () => {
    const own = () =>
      attestReconsideration(
        denial,
        { ...SYNTHETIC_REVERSAL_INPUT, kind: 'affirmation' },
        { ...SYNTHETIC_ATTESTATION, attestedAt: '2026-10-02T09:00:00+00:00' },
      );
    expect(own).toThrow(InvolvedReviewerError);
    expect(own).toThrow(/§ 422\.590\(h\)\(1\)/);
  });

  it('is the same person under another credential, so a second credential does not help', () => {
    expect(() =>
      attestReconsideration(denial, SYNTHETIC_REVERSAL_INPUT, {
        ...SYNTHETIC_ATTESTATION,
        credential: { type: 'synthetic-sleep-medicine-physician', jurisdiction: 'synthetic-j2' },
      }),
    ).toThrow(InvolvedReviewerError);
  });

  it('refuses a blank explanation and an initial record that is not an adverse determination', () => {
    expect(() =>
      attestReconsideration(
        denial,
        { ...SYNTHETIC_REVERSAL_INPUT, explanation: '  ' },
        SYNTHETIC_RECONSIDERING_ATTESTATION,
      ),
    ).toThrow();
    const approval = { kind: 'clinician-approval', attestation: SYNTHETIC_ATTESTATION };
    expect(() =>
      attestReconsideration(
        approval as unknown as typeof denial,
        SYNTHETIC_REVERSAL_INPUT,
        SYNTHETIC_RECONSIDERING_ATTESTATION,
      ),
    ).toThrow();
  });
});

describe('ReconsiderationRecordSchema (P3-F)', () => {
  it('rejects a stored record whose two reviewer ids are equal', () => {
    const edited = {
      ...SYNTHETIC_REVERSAL_INPUT,
      attestation: SYNTHETIC_ATTESTATION,
      initialReviewerId: SYNTHETIC_ATTESTATION.reviewerId,
    };
    const result = ReconsiderationRecordSchema.safeParse(edited);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'a reconsideration is made by someone not involved in the determination',
    );
  });

  it('rejects a kind that is neither a reversal nor an affirmation', () => {
    expect(
      ReconsiderationRecordSchema.safeParse({
        ...SYNTHETIC_REVERSAL_INPUT,
        kind: 'dismissal',
        attestation: SYNTHETIC_RECONSIDERING_ATTESTATION,
        initialReviewerId: 'synthetic-reviewer-001',
      }).success,
    ).toBe(false);
  });
});
