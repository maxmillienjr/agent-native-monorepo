import { describe, it, expect } from 'vitest';
import {
  AgentDispositionSchema,
  ClinicianAttestationSchema,
  DeterminationRecordSchema,
} from './determination.js';
import { SYNTHETIC_ATTESTATION, SYNTHETIC_DENIAL_INPUT } from './fixtures.js';

describe('DeterminationRecordSchema', () => {
  it('accepts an attested denial', () => {
    const result = DeterminationRecordSchema.safeParse({
      ...SYNTHETIC_DENIAL_INPUT,
      attestation: SYNTHETIC_ATTESTATION,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a denial with no attestation', () => {
    const result = DeterminationRecordSchema.safeParse(SYNTHETIC_DENIAL_INPUT);
    expect(result.success).toBe(false);
  });

  it('rejects a partial approval with no attestation', () => {
    const result = DeterminationRecordSchema.safeParse({
      kind: 'partial-approval',
      specificReason: 'Synthetic fixture: approved for fewer units than requested.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a denial whose specificReason is empty', () => {
    const result = DeterminationRecordSchema.safeParse({
      kind: 'denial',
      specificReason: '',
      attestation: SYNTHETIC_ATTESTATION,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a denial whose specificReason is only whitespace', () => {
    const result = DeterminationRecordSchema.safeParse({
      kind: 'denial',
      specificReason: '   ',
      attestation: SYNTHETIC_ATTESTATION,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an automated approval with no attestation', () => {
    const result = DeterminationRecordSchema.safeParse({
      kind: 'automated-approval',
      criteriaMet: ['synthetic-criterion-1'],
    });
    expect(result.success).toBe(true);
  });
});

describe('AgentDispositionSchema', () => {
  it('accepts an automated approval', () => {
    const result = AgentDispositionSchema.safeParse({
      kind: 'automated-approval',
      criteriaMet: ['synthetic-criterion-1'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a referral carrying a finding per criterion', () => {
    const result = AgentDispositionSchema.safeParse({
      kind: 'refer-to-clinician',
      findings: [
        {
          criterionId: 'synthetic-criterion-1',
          status: 'insufficient',
          evidence: ['Observation/synthetic-observation-1'],
          rationale: 'Synthetic fixture: the value is undated.',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects kind denial, even when it carries an attestation', () => {
    const result = AgentDispositionSchema.safeParse({
      ...SYNTHETIC_DENIAL_INPUT,
      attestation: SYNTHETIC_ATTESTATION,
    });
    expect(result.success).toBe(false);
  });

  it('rejects kind partial-approval, even when it carries an attestation', () => {
    const result = AgentDispositionSchema.safeParse({
      kind: 'partial-approval',
      specificReason: 'Synthetic fixture: approved for fewer units than requested.',
      attestation: SYNTHETIC_ATTESTATION,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an automated approval that reduces what was requested', () => {
    const result = AgentDispositionSchema.safeParse({
      kind: 'automated-approval',
      criteriaMet: ['synthetic-criterion-1'],
      approvedUnits: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('ClinicianAttestationSchema', () => {
  it('rejects an attestedAt with no offset', () => {
    const result = ClinicianAttestationSchema.safeParse({
      ...SYNTHETIC_ATTESTATION,
      attestedAt: '2026-09-26T14:00:00',
    });
    expect(result.success).toBe(false);
  });
});
