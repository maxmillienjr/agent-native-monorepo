import { z } from 'zod';

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const RetrievedContextItemSchema = z.object({
  source: z.enum(['neo4j', 'pgvector']),
  score: z.number(),
  content: z.string(),
  contentHash: z.string().optional(),
  entityId: z.string().optional(),
  episodeId: z.string().uuid().optional(),
});
export type RetrievedContextItem = z.infer<typeof RetrievedContextItemSchema>;

/**
 * A run's token usage, summed over every `generateContent` call a successful
 * node made: `plan`, each `act` step's tool selection, and `distill` (P1-F).
 *
 * `completion` is billed output — the visible answer plus the thinking tokens a
 * thinking model is billed for — derived from the reply's total the same way
 * the run's inference spans derive `gen_ai.usage.output_tokens`. Embedding
 * calls are not counted: the embedding API reports no usage.
 *
 * Until P1-F this was the `plan` call alone, with `completion` the visible
 * answer only. The shape did not change; the meaning did.
 *
 * A node that throws after its model call and is retried paid for both calls;
 * the spans record both and this total records the attempt that succeeded.
 */
export const TokenCountsSchema = z.object({
  prompt: z.number().int().nonnegative(),
  completion: z.number().int().nonnegative(),
});
export type TokenCounts = z.infer<typeof TokenCountsSchema>;

/**
 * How a run ended, as its response reports it.
 *
 * `awaiting-approval` is a run paused before an irreversible tool call, with
 * its checkpoint holding the call (P4-C). It is a value rather than a thrown
 * error because a paused run has not failed, and rather than `success`
 * because it has not finished: either would be the misreported outcome this
 * schema exists to prevent. No production tool is irreversible yet, so no
 * request reaches it until one is registered.
 */
export const OutcomeSchema = z.enum(['success', 'error', 'partial', 'awaiting-approval']);
export type Outcome = z.infer<typeof OutcomeSchema>;
