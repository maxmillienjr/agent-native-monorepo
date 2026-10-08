import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { episodes } from './schema.js';

export const EpisodeFindInputSchema = z.object({
  sessionId: z.string().uuid(),
  limit: z.number().int().positive().default(50),
});
export type EpisodeFindInput = z.infer<typeof EpisodeFindInputSchema>;

export const EpisodeWriteInputSchema = z.object({
  sessionId: z.string().uuid(),
  runId: z.string().uuid(),
  turnIndex: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
export type EpisodeWriteInput = z.infer<typeof EpisodeWriteInputSchema>;

export interface EpisodicRepository {
  write(input: EpisodeWriteInput): Promise<{ id: string }>;
  findBySession(
    input: EpisodeFindInput,
  ): Promise<Array<EpisodeWriteInput & { id: string; createdAt: Date }>>;
}

export class DrizzleEpisodicRepository implements EpisodicRepository {
  constructor(private readonly db: NodePgDatabase) {}

  /**
   * Writes one turn, idempotently.
   *
   * `reflect` writes every message in `state.messages` — the client-supplied
   * conversation history — so the same turn arrives again on every run of a
   * session and on every replay of a run. `(session_id, turn_index)` is the
   * natural key, and first write wins: a client that edits turn 0 and re-sends
   * the history gets its edit dropped rather than persisted. That is the
   * defensible behaviour for an append-only log — it records what was first
   * seen — but it means `episodes` is not a mirror of the client's current
   * history. P3-B kept it: an edited, re-sent turn is in the run record of the
   * run that sent it (ADR 0007), so an audit reads that and never this table.
   */
  async write(input: EpisodeWriteInput): Promise<{ id: string }> {
    const validated = EpisodeWriteInputSchema.parse(input);
    const [inserted] = await this.db
      .insert(episodes)
      .values({
        sessionId: validated.sessionId,
        runId: validated.runId,
        turnIndex: validated.turnIndex,
        role: validated.role,
        content: validated.content,
        metadata: validated.metadata ?? null,
      })
      .onConflictDoNothing({ target: [episodes.sessionId, episodes.turnIndex] })
      .returning({ id: episodes.id });

    if (inserted) return { id: inserted.id };

    // DO NOTHING returns no row on conflict. The turn is already persisted, so
    // report the id it was persisted under — callers treat this as a write that
    // happened, because from the log's point of view it did.
    const [existing] = await this.db
      .select({ id: episodes.id })
      .from(episodes)
      .where(
        and(
          eq(episodes.sessionId, validated.sessionId),
          eq(episodes.turnIndex, validated.turnIndex),
        ),
      )
      .limit(1);

    return { id: existing!.id };
  }

  async findBySession(
    input: EpisodeFindInput,
  ): Promise<Array<EpisodeWriteInput & { id: string; createdAt: Date }>> {
    const validated = EpisodeFindInputSchema.parse(input);
    const rows = await this.db
      .select()
      .from(episodes)
      .where(eq(episodes.sessionId, validated.sessionId))
      .orderBy(desc(episodes.createdAt))
      .limit(validated.limit);

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      runId: row.runId,
      turnIndex: row.turnIndex,
      role: row.role as 'user' | 'assistant' | 'tool',
      content: row.content,
      metadata: row.metadata as Record<string, unknown> | undefined,
      createdAt: row.createdAt,
    }));
  }
}
