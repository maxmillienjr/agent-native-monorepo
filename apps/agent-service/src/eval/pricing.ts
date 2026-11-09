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
 * the spans count it. CI's key is on the free tier and bills nothing, and the
 * owner's development key is billed (ADR 0018), so the report calls the figure a
 * list-price equivalent either way. Nothing asserts it.
 *
 * Only the pinned id is priced. `gemini-2.5-flash`, the pin until P1-I, listed
 * at the same $0.30 and $2.50 on 2026-10-08; nothing at HEAD prices a run on
 * it, and a report made then carries its own cost column.
 *
 * `gemini-embedding-001` is absent because the page lists no price for it —
 * its only embedding model is Gemini Embedding 2 — and because the embedding
 * response reports no usage to price. The report counts those calls as
 * unpriced, never as free.
 *
 * Nothing checks the page. A price change reaches the report when someone edits
 * this file, dates included. The `ai.google.dev/gemini-api/docs/` pages now
 * redirect to `aistudio.google.com/docs/`.
 */
export const GEMINI_PRICES: PriceTable = {
  source: 'https://aistudio.google.com/docs/pricing',
  // Confirmed against the page on 2026-11-09 (P1-I): $0.30 input for text,
  // image, video and audio, $2.50 output including thinking, no scheduled
  // change. The page carries no date of its own.
  pageLastUpdated: 'undated',
  readOn: '2026-11-09',
  tier: 'paid, standard',
  models: {
    [PINNED_CHAT_MODEL]: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  },
};
