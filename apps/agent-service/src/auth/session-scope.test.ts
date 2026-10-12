import { describe, expect, it } from 'vitest';
import { contextSessionId } from '../a2a/session-id.js';
import { runsSessionId } from './session-scope.js';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('runsSessionId', () => {
  it('returns a version 5 UUID', () => {
    expect(runsSessionId('console', SESSION)).toMatch(UUID_V5);
  });

  it('is stable for one principal and session id', () => {
    expect(runsSessionId('console', SESSION)).toBe(runsSessionId('console', SESSION));
  });

  it('gives two principals with one session id two sessions', () => {
    expect(runsSessionId('a', SESSION)).not.toBe(runsSessionId('b', SESSION));
  });

  it('is not the session id the client sent', () => {
    expect(runsSessionId('anonymous', SESSION)).not.toBe(SESSION);
  });

  it('differs from the A2A session for the same principal and the same string', () => {
    expect(runsSessionId('console', SESSION)).not.toBe(contextSessionId('console', SESSION));
  });

  it("gives another principal's derived id a session of the caller's own", () => {
    // P5-D's measurement: `b` computed `a`'s A2A session and sent it to /runs.
    const stolen = contextSessionId('a', 'ctx-1');

    expect(runsSessionId('b', stolen)).not.toBe(stolen);
    expect(runsSessionId('b', stolen)).not.toBe(runsSessionId('a', stolen));
  });
});
