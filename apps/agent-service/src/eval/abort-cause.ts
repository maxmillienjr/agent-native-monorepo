import type { AbortCause } from '@repo/eval-harness';
import { classifyRateLimit, dailyQuotaIds } from '../agent/model/rate-limit.js';
import type { RunProgress } from './run-suite.js';

/** The command that refreshes the committed cassette set, as the README gives it. */
export const RE_RECORD_COMMAND = 'EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval';

/**
 * Which model API an error came from, for a sentence a reader can act on.
 * `EmbeddingRequestError` is ours; everything else that carries a 429 here is
 * the chat client's.
 */
function apiOf(error: unknown): string {
  return error instanceof Error && error.name === 'EmbeddingRequestError'
    ? 'embedContent'
    : 'generateContent';
}

function trialsDone(progress: RunProgress): string {
  const count = progress.completed.length;
  return `${count} completed trial${count === 1 ? '' : 's'}`;
}

/**
 * The named cause of an abort, for the two errors a reader can do something
 * specific about. Everything else is reported by its name and message alone,
 * which is already more than the fatal log line used to leave.
 *
 * Matched by `name` so this file does not reach into the cassette package for
 * a class, the same choice `IO_RETRY` makes.
 */
export function explainAbort(error: unknown, progress: RunProgress): AbortCause | undefined {
  if (error instanceof Error && error.name === 'CassetteMissError') {
    return {
      code: 'cassette-miss',
      summary:
        'a replayed trial made a request the cassette set has no recording of. The usual ' +
        'cause is a prompt or request edit, which is P1-B working as designed; the diff below ' +
        'says what moved. On a pull request that touches no prompt, suspect the store images, ' +
        'whose floating tags can reorder rows.',
      remedy:
        `re-record with a key: \`${RE_RECORD_COMMAND}\`, on the live model axis. It costs ` +
        'about eight `generateContent` calls against a daily free tier of twenty, so it is a ' +
        'deliberate local command and never a CI step.',
    };
  }

  const rateLimit = classifyRateLimit(error);
  if (rateLimit === 'daily-quota') {
    const details = (error as { errorDetails?: unknown }).errorDetails;
    const ids = dailyQuotaIds(Array.isArray(details) ? details : []);
    return {
      code: 'daily-quota',
      summary:
        `daily \`${apiOf(error)}\` quota exhausted after ${trialsDone(progress)}` +
        (ids.length > 0 ? ` (\`${ids.join('`, `')}\`)` : '') +
        '. No retry can succeed before the quota resets, so none was made.',
      remedy: 'wait for the daily reset, or run with a key from a project that has quota left.',
    };
  }
  if (rateLimit === 'unclassified') {
    const api = apiOf(error);
    return {
      code: 'rate-limit-unclassified',
      summary:
        `\`${api}\` answered 429 after ${trialsDone(progress)}, and the response did not ` +
        'name a per-day quota.' +
        (api === 'generateContent' ? ' The chat client retried it six times first.' : ''),
    };
  }

  return undefined;
}
