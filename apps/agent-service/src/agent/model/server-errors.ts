import type { FailedAttemptHandler } from '@langchain/core/utils/async_caller';
import { stopOnDailyQuota } from './rate-limit.js';

/**
 * The status of a provider-side 5xx, or `undefined` for anything else.
 *
 * Reads `status`, which is where `@google/generative-ai`'s
 * `GoogleGenerativeAIFetchError` carries the response's code on the chat path.
 */
export function serverErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 500 && status <= 599 ? status : undefined;
}

/**
 * A chat call that met a provider 5xx on its request and on its one retry.
 *
 * Thrown only by a client built with `boundServerErrors`, which `yarn eval`
 * asks for on the live model axis and when recording (P1-I). Named, so that
 * `IO_RETRY` can refuse to re-run the node — three node attempts of two
 * requests each would be six requests, the spend the bound exists to stop —
 * and so that `explainAbort` can name the cause without importing this file's
 * class, the same choice it makes for a cassette miss.
 */
export class ProviderUnavailableError extends Error {
  /** The last attempt's status, for `eval-abort.json`. */
  readonly status: number;

  constructor(
    readonly api: string,
    readonly attempts: number,
    last: unknown,
    status: number,
  ) {
    const detail = last instanceof Error ? last.message : String(last);
    super(`${api} answered ${status} on ${attempts} consecutive requests: ${detail}`, {
      cause: last,
    });
    this.name = 'ProviderUnavailableError';
    this.status = status;
  }
}

/**
 * The bounded client's `onFailedAttempt`: a provider 5xx is terminal at
 * LangChain's layer, and everything else — both kinds of 429 included — is
 * decided as `stopOnDailyQuota` decides it.
 *
 * Terminal here because LangChain's `AsyncCaller` would otherwise retry a 503
 * six times, and its handler is given the error and not the attempt number, so
 * it cannot stop after one. `retryServerErrorOnce` makes the one retry instead,
 * around the whole call.
 */
export const stopOnServerError: FailedAttemptHandler = (error: unknown) => {
  if (serverErrorStatus(error) !== undefined) throw error;
  return stopOnDailyQuota(error);
};

/**
 * Before the one retry. LangChain's own first retry waits one to two seconds;
 * this is the top of that range.
 */
export const SERVER_ERROR_RETRY_DELAY_MS = 2_000;

/**
 * Runs `call`, retries it once if it fails with a provider 5xx, and throws
 * `ProviderUnavailableError` if the retry fails with one too. Any other error
 * is thrown as it came.
 *
 * Two requests for one call at most, where LangChain's default makes seven.
 * On 2026-11-09 a live recording made 20 requests and got 9 answers, because
 * each 503 retry is a request against the free tier's 20 a day.
 */
export async function retryServerErrorOnce<T>(api: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (serverErrorStatus(error) === undefined) throw error;
  }

  await new Promise((resolve) => setTimeout(resolve, SERVER_ERROR_RETRY_DELAY_MS));

  try {
    return await call();
  } catch (error) {
    const status = serverErrorStatus(error);
    if (status === undefined) throw error;
    throw new ProviderUnavailableError(api, 2, error, status);
  }
}
