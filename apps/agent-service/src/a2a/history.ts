import type { Message } from '@repo/shared-types';
import type { EpisodicRepository } from '@repo/memory-core';

/** The most turns an A2A context can hold before a message to it is refused. */
export const HISTORY_LIMIT = 200;

/** A session whose stored turns cannot be rebuilt into a request safely. */
export class HistoryError extends Error {
  override readonly name = 'HistoryError';
}

/**
 * A context's conversation so far, from episodic memory.
 *
 * A2A sends one message per call and the run contract wants the whole
 * history, so it is rebuilt here: a read through `memory-core`, while
 * `reflect` stays the only writer. `reflect` writes every message at its array
 * index as `turnIndex`, `ON CONFLICT DO NOTHING`, so the rebuilt history has
 * to be exactly turns `0..n-1`. A gap, or more turns than the read returns,
 * would put the new user message at an index already taken, and the write
 * would drop it without an error. Either is refused instead.
 *
 * `findBySession` orders by `createdAt`, newest first, so the rows are sorted
 * by index here. With no memory axis there is nothing to read, and every
 * message is a conversation of one.
 */
export async function rebuildHistory(
  repo: EpisodicRepository | null,
  sessionId: string,
): Promise<Message[]> {
  if (repo === null) return [];

  const rows = await repo.findBySession({ sessionId, limit: HISTORY_LIMIT + 1 });
  if (rows.length > HISTORY_LIMIT) {
    throw new HistoryError(`This conversation has more than ${HISTORY_LIMIT} turns.`);
  }

  const turns = [...rows].sort((a, b) => a.turnIndex - b.turnIndex);
  turns.forEach((turn, index) => {
    if (turn.turnIndex !== index) {
      throw new HistoryError(`This conversation's stored history has a gap at turn ${index}.`);
    }
  });

  return turns.map((turn) => ({ role: turn.role, content: turn.content }));
}
