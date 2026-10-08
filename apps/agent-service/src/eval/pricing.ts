import type { PriceTable } from '@repo/eval-harness';
import { PINNED_CHAT_MODEL } from '../agent/model/model-deps.js';

/**
 * List prices for the models this service calls, for the cost column of an
 * evaluation report (P1-F).
 *
 * Beside the chat model ids rather than in `@repo/eval-harness`, which knows
 * no provider. Keyed on `PINNED_CHAT_MODEL`, not `CHAT_MODEL`: a run that
 * `EVAL_CHAT_MODEL` moved to the floating alias must print that alias as
 * unpriced rather than charge it the pinned id's price, since the page prices
 * each id separately. The figures are the paid tier's, copied from the page: "Output
 * price (including thinking tokens)", so the output price applies to output as
 * the spans count it. The free tier the repository's key is on bills nothing,
 * so the report calls the figure a list-price equivalent. Nothing asserts it.
 *
 * `gemini-embedding-001` is absent because the page lists no price for it —
 * its only embedding model is Gemini Embedding 2 — and because the embedding
 * response reports no usage to price. The report counts those calls as
 * unpriced, never as free.
 *
 * Nothing checks the page. A price change reaches the report when someone edits
 * this file, dates included.
 */
export const GEMINI_PRICES: PriceTable = {
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  pageLastUpdated: '2026-10-07',
  readOn: '2026-10-08',
  tier: 'paid, standard',
  models: {
    [PINNED_CHAT_MODEL]: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  },
};
