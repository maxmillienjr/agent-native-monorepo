import { z } from 'zod';
import { AsyncCaller, type FailedAttemptHandler } from '@langchain/core/utils/async_caller';

/**
 * What kind of 429 an error is.
 *
 * `daily-quota` is the one this repository actually runs into: the free tier
 * allows twenty `generateContent` requests a day, and no retry at any layer can
 * succeed against a limit that resets tomorrow. Everything else answered with a
 * 429 is `unclassified` — a per-minute limit, a capacity shed, a body with no
 * details — and keeps whatever retry behaviour it had.
 */
export type RateLimit = 'daily-quota' | 'unclassified';

/**
 * The `google.rpc.QuotaFailure` detail, and only the part the classifier reads.
 *
 * Validated rather than cast because this is a body written by someone else's
 * server and relayed by someone else's client. A detail that does not parse is
 * not a daily quota, which leaves the call on its existing retry path.
 */
const QuotaFailureSchema = z.object({
  '@type': z.literal('type.googleapis.com/google.rpc.QuotaFailure'),
  violations: z.array(z.object({ quotaId: z.string().optional() }).passthrough()),
});

/**
 * Google names each quota by its window: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`
 * against `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`. The id is the
 * only field in the documented error model that says which window ran out.
 */
const PER_DAY = /PerDay/i;

const ErrorShapeSchema = z.object({
  status: z.literal(429),
  errorDetails: z.array(z.unknown()).optional(),
});

/**
 * Classifies a model-client error as a rate limit, or returns `undefined` when
 * it is not a 429 at all.
 *
 * Reads `status` and `errorDetails`, which is how `@google/generative-ai`'s
 * `GoogleGenerativeAIFetchError` carries a response on the chat path, and how
 * `EmbeddingRequestError` carries one on the embed path.
 */
export function classifyRateLimit(error: unknown): RateLimit | undefined {
  const parsed = ErrorShapeSchema.safeParse(error);
  if (!parsed.success) return undefined;

  return dailyQuotaIds(parsed.data.errorDetails ?? []).length > 0 ? 'daily-quota' : 'unclassified';
}

/** Every per-day quota id named in a set of error details. */
export function dailyQuotaIds(details: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const detail of details) {
    const failure = QuotaFailureSchema.safeParse(detail);
    if (!failure.success) continue;
    for (const violation of failure.data.violations) {
      if (violation.quotaId !== undefined && PER_DAY.test(violation.quotaId)) {
        ids.push(violation.quotaId);
      }
    }
  }
  return ids;
}

/**
 * LangChain's own handler, read off an `AsyncCaller` rather than copied.
 *
 * `@langchain/core` does not export it at the pinned version, and a copy would
 * silently stop matching the day an upgrade changed which statuses it treats
 * as terminal. The property is protected, so a subclass is what can read it.
 */
class DefaultAttemptHandler extends AsyncCaller {
  static read(): FailedAttemptHandler {
    const handler = new DefaultAttemptHandler({}).onFailedAttempt;
    if (handler === undefined) {
      throw new Error('AsyncCaller constructed without a default onFailedAttempt handler');
    }
    return handler;
  }
}

const defaultAttemptHandler = DefaultAttemptHandler.read();

/**
 * The chat client's `onFailedAttempt`: a daily-quota 429 is terminal, and
 * everything else is decided exactly as LangChain's default decides it.
 *
 * Without it, `AsyncCaller` retries a 429 up to six times with exponential
 * backoff — measured at seven requests over 92 seconds for one `invoke` — and
 * against an exhausted daily quota every one of those requests is spent for
 * nothing. A transient 429 keeps the six retries it has always had.
 */
export const stopOnDailyQuota: FailedAttemptHandler = (error: unknown) => {
  if (classifyRateLimit(error) === 'daily-quota') throw error;
  return defaultAttemptHandler(error);
};
