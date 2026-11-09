import { describe, it, expect } from 'vitest';
import { readMemoryConfig } from './memory.config.js';

describe('readMemoryConfig', () => {
  it('returns null when DATABASE_URL is unset or empty', () => {
    // The no-database path is load-bearing: a clone with no .env still has to
    // serve both README quickstart curls.
    expect(readMemoryConfig({})).toBeNull();
    expect(readMemoryConfig({ DATABASE_URL: '' })).toBeNull();
  });

  it('selects the memory axis on DATABASE_URL alone (P2-E)', () => {
    expect(readMemoryConfig({ DATABASE_URL: 'postgresql://localhost:5432/agentdb' })).toEqual({
      databaseUrl: 'postgresql://localhost:5432/agentdb',
    });
  });

  it('reads no variable but DATABASE_URL, so a leftover graph variable is ignored (P2-E)', () => {
    // Before P2-E a second store's URI was required beside DATABASE_URL, and
    // one without the other refused to boot. An old .env can still carry it.
    const read = new Set<string>();
    const env = new Proxy(
      { DATABASE_URL: 'postgresql://localhost:5432/agentdb' } as NodeJS.ProcessEnv,
      {
        get(target, key) {
          if (typeof key === 'string') read.add(key);
          return target[key as string];
        },
      },
    );
    readMemoryConfig(env);
    expect([...read]).toEqual(['DATABASE_URL']);
  });
});
