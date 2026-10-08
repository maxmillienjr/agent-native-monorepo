import { describe, expect, it } from 'vitest';
import {
  compareCases,
  decisionDueBy,
  isOverdue,
  priorityFromCode,
  type QueueKey,
} from './clock.js';

describe('decisionDueBy', () => {
  const receivedAt = new Date('2026-03-01T10:00:00Z');

  it('gives a standard request 168 hours from receipt', () => {
    expect(decisionDueBy(receivedAt, 'standard').toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });

  it('gives an expedited request 72 hours from receipt', () => {
    expect(decisionDueBy(receivedAt, 'expedited').toISOString()).toBe('2026-03-04T10:00:00.000Z');
  });

  it('counts hours, not calendar dates, across a daylight-saving change', () => {
    // US clocks moved on 2026-03-08; the deadline does not.
    expect(decisionDueBy(new Date('2026-03-05T12:00:00Z'), 'standard').toISOString()).toBe(
      '2026-03-12T12:00:00.000Z',
    );
  });
});

describe('priorityFromCode', () => {
  it('reads stat as expedited and anything else as standard', () => {
    expect(priorityFromCode('stat')).toBe('expedited');
    expect(priorityFromCode('normal')).toBe('standard');
    expect(priorityFromCode('deferred')).toBe('standard');
    expect(priorityFromCode(undefined)).toBe('standard');
  });
});

describe('isOverdue', () => {
  const receivedAt = new Date('2026-03-01T10:00:00Z');

  it('is not overdue a second before a standard deadline and is overdue at it', () => {
    const standard = { decisionDueBy: decisionDueBy(receivedAt, 'standard') };
    expect(isOverdue(standard, new Date('2026-03-08T09:59:59Z'))).toBe(false);
    expect(isOverdue(standard, new Date('2026-03-08T10:00:00Z'))).toBe(true);
  });

  it('makes an expedited case overdue at 72 hours', () => {
    const expedited = { decisionDueBy: decisionDueBy(receivedAt, 'expedited') };
    expect(isOverdue(expedited, new Date('2026-03-04T09:59:59Z'))).toBe(false);
    expect(isOverdue(expedited, new Date('2026-03-04T10:00:00Z'))).toBe(true);
  });
});

describe('compareCases', () => {
  const key = (caseId: string, received: string, due: string): QueueKey => ({
    caseId,
    receivedAt: new Date(received),
    decisionDueBy: new Date(due),
  });

  it('orders by deadline, then receipt, then case id', () => {
    const late = key('a', '2026-03-01T09:00:00Z', '2026-03-08T09:00:00Z');
    const expedited = key('z', '2026-03-02T09:00:00Z', '2026-03-05T09:00:00Z');
    const sameDueEarlier = key('m', '2026-03-01T08:00:00Z', '2026-03-08T09:00:00Z');
    const tieB = key('b', '2026-03-01T09:00:00Z', '2026-03-08T09:00:00Z');

    expect([late, tieB, expedited, sameDueEarlier].sort(compareCases).map((c) => c.caseId)).toEqual(
      ['z', 'm', 'a', 'b'],
    );
  });

  it('is zero only for the same case id and clock', () => {
    const one = key('a', '2026-03-01T09:00:00Z', '2026-03-08T09:00:00Z');
    expect(compareCases(one, { ...one })).toBe(0);
    expect(compareCases(one, { ...one, caseId: 'b' })).toBeLessThan(0);
  });
});
