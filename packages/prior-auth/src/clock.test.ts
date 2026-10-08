import { describe, expect, it } from 'vitest';
import { decisionDueBy, priorityFromCode } from './clock.js';

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
