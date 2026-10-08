import type { ClinicianAttestation } from './determination.js';

/**
 * Fabricated test values, labelled so (ADR 0003). The reviewer is not an NPI,
 * the credential names no real licensing board, and no field holds a
 * procedure code.
 */
export const SYNTHETIC_ATTESTATION: ClinicianAttestation = {
  reviewerId: 'synthetic-reviewer-001',
  credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
  attestedAt: '2026-09-26T14:00:00+00:00',
};

export const SYNTHETIC_DENIAL_INPUT = {
  kind: 'denial',
  specificReason: 'Synthetic fixture: criterion synthetic-criterion-2 is not evidenced.',
} as const;

/** A second synthetic reviewer, who took no part in `SYNTHETIC_ATTESTATION`'s denial (P3-F). */
export const SYNTHETIC_RECONSIDERING_ATTESTATION: ClinicianAttestation = {
  reviewerId: 'synthetic-reviewer-002',
  credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
  attestedAt: '2026-10-02T09:00:00+00:00',
};

export const SYNTHETIC_REVERSAL_INPUT = {
  kind: 'reversal',
  explanation: 'Synthetic fixture: the appeal evidence documents synthetic-criterion-2.',
  goodCauseFound: false,
} as const;
