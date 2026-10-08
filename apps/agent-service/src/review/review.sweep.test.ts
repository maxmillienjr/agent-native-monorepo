import { describe, expect, it } from 'vitest';
import { InMemoryAppealRepository, InMemoryCaseRepository } from '@repo/memory-core';
import { ReviewSweep, readSweepMs } from './review.sweep.js';

describe('readSweepMs', () => {
  it('defaults to a minute, takes 0 to turn the timer off, and refuses anything else', () => {
    expect(readSweepMs({})).toBe(60_000);
    expect(readSweepMs({ REVIEW_SWEEP_MS: '0' })).toBe(0);
    expect(readSweepMs({ REVIEW_SWEEP_MS: '5000' })).toBe(5000);
    expect(() => readSweepMs({ REVIEW_SWEEP_MS: 'soon' })).toThrow(/REVIEW_SWEEP_MS is soon/);
    expect(() => readSweepMs({ REVIEW_SWEEP_MS: '-1' })).toThrow(/REVIEW_SWEEP_MS/);
  });
});

describe('ReviewSweep', () => {
  it('flags only pended cases at or past their deadline, and decides none', async () => {
    const cases = new InMemoryCaseRepository();
    const base = {
      status: 'pended' as const,
      priority: 'expedited' as const,
      receivedAt: new Date('2026-03-01T10:00:00Z'),
      decisionDueBy: new Date('2026-03-04T10:00:00Z'),
      memberId: 'https://example.org/fhir/sid/member-id|SYN-SWEEP',
      insurerId: 'https://example.org/fhir/sid/payer-id|QHP-SYN-001',
      providerId: 'https://example.org/fhir/sid/supplier-id|SUP-01',
      hcpcs: 'E0601',
      request: { resourceType: 'Bundle' },
      disposition: { kind: 'refer-to-clinician' as const, findings: [] },
      response: { resourceType: 'Bundle' },
      recommendationSeq: null,
    };
    await cases.enqueue({ ...base, caseId: '00000000-0000-4000-8000-000000000001' });
    await cases.enqueue({
      ...base,
      caseId: '00000000-0000-4000-8000-000000000002',
      decisionDueBy: new Date('2026-03-04T10:00:01Z'),
    });
    const sweep = new ReviewSweep(cases, new InMemoryAppealRepository(cases), {
      now: () => new Date('2026-03-04T10:00:00Z'),
    });

    const { flagged, forwarded } = await sweep.sweep();
    expect(forwarded).toEqual([]);
    expect(flagged.map((c) => c.caseId)).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect((await cases.queue(10)).map((c) => c.status)).toEqual(['pended', 'pended']);
    expect(await sweep.sweep()).toEqual({ flagged: [], forwarded: [] });
  });
});
