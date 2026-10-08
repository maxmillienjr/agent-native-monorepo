import { describe, expect, it } from 'vitest';
import type { EpisodicRepository } from '@repo/memory-core';
import { HISTORY_LIMIT, HistoryError, rebuildHistory } from './history.js';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const RUN = '550e8400-e29b-41d4-a716-446655440001';

function repo(turns: number[]): EpisodicRepository & { limits: number[] } {
  const limits: number[] = [];
  return {
    limits,
    write: async () => ({ id: RUN }),
    // Newest first by createdAt, as the Drizzle repository returns them.
    findBySession: async ({ limit }) => {
      limits.push(limit);
      return turns
        .map((turnIndex) => ({
          id: `${turnIndex}`,
          sessionId: SESSION,
          runId: RUN,
          turnIndex,
          role: turnIndex % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `turn ${turnIndex}`,
          createdAt: new Date(1_000 + turnIndex),
        }))
        .reverse()
        .slice(0, limit);
    },
  };
}

describe('rebuildHistory', () => {
  it('is empty with no memory axis', async () => {
    expect(await rebuildHistory(null, SESSION)).toEqual([]);
  });

  it('returns the turns in index order', async () => {
    expect(await rebuildHistory(repo([0, 1]), SESSION)).toEqual([
      { role: 'user', content: 'turn 0' },
      { role: 'assistant', content: 'turn 1' },
    ]);
  });

  it('asks for one turn more than it accepts, so an over-long context is seen', async () => {
    const store = repo([...Array(HISTORY_LIMIT + 5).keys()]);

    await expect(rebuildHistory(store, SESSION)).rejects.toThrow(HistoryError);
    expect(store.limits).toEqual([HISTORY_LIMIT + 1]);
  });

  it('refuses a gap, which would put the new turn at an index already taken', async () => {
    await expect(rebuildHistory(repo([0, 2]), SESSION)).rejects.toThrow(/gap at turn 1/);
  });
});
