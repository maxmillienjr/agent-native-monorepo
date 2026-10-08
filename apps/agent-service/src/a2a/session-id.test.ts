import { describe, expect, it } from 'vitest';
import { contextSessionId, uuidV5 } from './session-id.js';

describe('uuidV5', () => {
  it('matches the RFC 9562 example', () => {
    // RFC 9562 Appendix A.4: "www.example.com" in the DNS namespace.
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });
});

describe('contextSessionId', () => {
  it('is stable for one principal and context', () => {
    expect(contextSessionId('console', 'ctx-1')).toBe(contextSessionId('console', 'ctx-1'));
  });

  it('gives two principals in one context two sessions', () => {
    expect(contextSessionId('console', 'ctx-1')).not.toBe(contextSessionId('tck', 'ctx-1'));
  });

  it('accepts a context id that is not a UUID and returns one', () => {
    expect(contextSessionId('console', 'not a uuid')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
