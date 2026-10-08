import { describe, expect, it } from 'vitest';
import { filingDeadline, isLapsed, reconsiderationDueBy } from './appeal-clock.js';

const at = (iso: string) => new Date(iso);

describe('reconsiderationDueBy and isLapsed (P3-F)', () => {
  it('lapses a standard appeal 30 days after receipt, to the instant', () => {
    const appeal = {
      reconsiderationDueBy: reconsiderationDueBy(at('2026-03-01T10:00:00Z'), 'standard'),
    };
    expect(isLapsed(appeal, at('2026-03-31T09:59:59Z'))).toBe(false);
    expect(isLapsed(appeal, at('2026-03-31T10:00:00Z'))).toBe(true);
  });

  it('lapses an expedited appeal 72 hours after receipt', () => {
    const appeal = {
      reconsiderationDueBy: reconsiderationDueBy(at('2026-03-01T10:00:00Z'), 'expedited'),
    };
    expect(appeal.reconsiderationDueBy.toISOString()).toBe('2026-03-04T10:00:00.000Z');
    expect(isLapsed(appeal, at('2026-03-04T09:59:59.999Z'))).toBe(false);
    expect(isLapsed(appeal, at('2026-03-04T10:00:00Z'))).toBe(true);
  });
});

describe('filingDeadline (P3-F)', () => {
  const determinationDate = at('2026-03-01T15:00:00Z');

  it('is the end of the UTC day 65 days after the determination, by presumption', () => {
    expect(filingDeadline({ determinationDate }).toISOString()).toBe('2026-05-05T23:59:59.999Z');
  });

  it('counts 60 days from a later receipt the filer gives', () => {
    expect(
      filingDeadline({ determinationDate, noticeReceivedAt: at('2026-03-20') }).toISOString(),
    ).toBe('2026-05-19T23:59:59.999Z');
  });

  it('keeps the presumed deadline when the given receipt is earlier than the presumption', () => {
    expect(
      filingDeadline({ determinationDate, noticeReceivedAt: at('2026-03-02') }).toISOString(),
    ).toBe('2026-05-05T23:59:59.999Z');
  });
});
