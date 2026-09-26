import { z } from 'zod';
import type { RetryPolicy } from '@langchain/langgraph';

/**
 * Detects a 4xx from a model client or an HTTP-shaped error.
 *
 * Retrying one spends latency to reach the same answer: a malformed request,
 * a rejected key or a missing model is not going to succeed on attempt three.
 */
function isClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Detects a replay that asked a cassette for a decision it does not hold.
 *
 * A miss consumes nothing, so attempts two and three ask the same deck the same
 * question and miss again; retrying one only delays the diff the error carries
 * by the length of the backoff. Matched on `name` rather than the class so that
 * graph code does not import the cassette package.
 */
function isCassetteMiss(error: unknown): boolean {
  return error instanceof Error && error.name === 'CassetteMissError';
}

/**
 * Applied to every node that performs I/O.
 *
 * Note what this requires of those nodes: a `retryPolicy` only ever fires on a
 * thrown error, so an I/O node that catches its own failure and returns
 * `Partial<AgentState>` makes `retryOn` unreachable and this policy a
 * decoration. That is why `.context/conventions.md` distinguishes throwing
 * from swallowing — containment happens once, at the graph boundary, where an
 * exhausted retry becomes a failed run with the checkpoint intact.
 */
export const IO_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 200,
  backoffFactor: 2,
  jitter: true,
  retryOn: (error: unknown) =>
    !(error instanceof z.ZodError) && !isClientError(error) && !isCassetteMiss(error),
};
