import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialsConfigError, parseCredentials } from './credentials.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

describe('parseCredentials', () => {
  it('is open when the variable is unset or empty', () => {
    expect(parseCredentials({})).toEqual({ mode: 'open' });
    expect(parseCredentials({ SERVICE_CREDENTIALS: '  ' })).toEqual({ mode: 'open' });
  });

  it('holds a digest per principal, never a token', () => {
    const parsed = parseCredentials({
      SERVICE_CREDENTIALS: `console:${digest('a')}, tck:${digest('b')}`,
    });
    expect(parsed.mode).toBe('enforced');
    if (parsed.mode !== 'enforced') return;
    expect(parsed.credentials.map((c) => c.principal)).toEqual(['console', 'tck']);
    expect(parsed.credentials[0]!.digest.toString('hex')).toBe(digest('a'));
  });

  it.each([
    ['nocolon'],
    ['console:'],
    [`console:${digest('a').toUpperCase()}`],
    [`:${digest('a')}`],
    [`console:${digest('a')},`],
  ])('refuses %j and names the variable without echoing the entry', (value) => {
    expect(() => parseCredentials({ SERVICE_CREDENTIALS: value })).toThrow(CredentialsConfigError);
    expect(() => parseCredentials({ SERVICE_CREDENTIALS: value })).toThrow(/^SERVICE_CREDENTIALS/);
    try {
      parseCredentials({ SERVICE_CREDENTIALS: value });
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('refuses the reserved open-mode principal, a repeated principal and a shared token', () => {
    expect(() => parseCredentials({ SERVICE_CREDENTIALS: `anonymous:${digest('a')}` })).toThrow(
      /reserves/,
    );
    expect(() =>
      parseCredentials({ SERVICE_CREDENTIALS: `a:${digest('a')},a:${digest('b')}` }),
    ).toThrow(/twice/);
    expect(() =>
      parseCredentials({ SERVICE_CREDENTIALS: `a:${digest('a')},b:${digest('a')}` }),
    ).toThrow(/one token/);
  });
});
