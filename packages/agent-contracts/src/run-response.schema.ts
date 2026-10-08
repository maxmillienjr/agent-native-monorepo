import { z } from 'zod';
import {
  UuidSchema,
  MessageSchema,
  RetrievedContextItemSchema,
  TokenCountsSchema,
  OutcomeSchema,
} from '@repo/shared-types';

/**
 * Strict, because `buildRunResponse` parses every response through it before
 * it leaves the service. A non-strict object strips an unknown key, so a value
 * placed under any key this schema does not declare — a denial, say — would
 * vanish from the response and the defect that put it there would never
 * surface. Strict turns it into an error (P3-A).
 */
export const RunResponseSchema = z
  .object({
    runId: UuidSchema,
    sessionId: UuidSchema,
    messages: z.array(MessageSchema),
    outcome: OutcomeSchema,
    /**
     * Every model call the run made, not the `plan` call alone, with
     * `completion` counting thinking tokens (P1-F; see `TokenCountsSchema`).
     */
    tokenCounts: TokenCountsSchema,
    retrievedContext: z.array(RetrievedContextItemSchema),
  })
  .strict();
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const StreamEventSchema = z.object({
  node: z.string(),
  delta: z.string().optional(),
  /**
   * The terminal frame of a failed stream.
   *
   * `POST /runs/stream` commits its response with the first frame, so a node
   * that throws afterwards cannot be answered with a JSON error body — the
   * exception filter's `res.status().json()` raises ERR_HTTP_HEADERS_SENT and
   * the client is left with a stream that stops mid-run. Containment for a
   * stream is a frame.
   *
   * A field rather than a sentinel `node` value: an implicit protocol carried
   * in a `z.string()` is the kind of thing a reader has to run the code to
   * discover.
   */
  error: z.object({ node: z.string(), message: z.string() }).optional(),
  state: z
    .object({
      runId: UuidSchema.optional(),
      sessionId: UuidSchema.optional(),
      outcome: OutcomeSchema.optional(),
      tokenCounts: TokenCountsSchema.optional(),
    })
    .optional(),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;
