/**
 * Per-trial budgets for the assessing tasks, written into each task file by
 * the author. They are measurements, not scenario content: P1-F's rule applied
 * to the 2026-11-17 recording at `3ea2533` (input × 1.5 and output × 2, to the
 * next hundred), and `modelCalls` 2, the one `assess.criteria` call and one
 * retry. An administrative task makes no call and has none, because a trial
 * with no model span is unmeasurable. Re-derive them with the recording that
 * changes them, in the same pull request (`.context/conventions.md`).
 */
export const BUDGETS: Readonly<
  Record<
    string,
    { readonly inputTokens: number; readonly outputTokens: number; readonly modelCalls: number }
  >
> = {
  'pa-e0260-all-met-narrative': { inputTokens: 1100, outputTokens: 800, modelCalls: 2 },
  'pa-e0260-all-met-structured': { inputTokens: 1100, outputTokens: 700, modelCalls: 2 },
  'pa-e0260-ambiguous': { inputTokens: 1100, outputTokens: 700, modelCalls: 2 },
  'pa-e0260-contradicted': { inputTokens: 1100, outputTokens: 700, modelCalls: 2 },
  'pa-e0260-one-missing': { inputTokens: 1100, outputTokens: 600, modelCalls: 2 },
  'pa-e0470-all-met-narrative': { inputTokens: 1300, outputTokens: 900, modelCalls: 2 },
  'pa-e0470-all-met-structured': { inputTokens: 1600, outputTokens: 900, modelCalls: 2 },
  'pa-e0470-ambiguous': { inputTokens: 1500, outputTokens: 800, modelCalls: 2 },
  'pa-e0470-contradicted': { inputTokens: 1600, outputTokens: 900, modelCalls: 2 },
  'pa-e0470-one-missing': { inputTokens: 1400, outputTokens: 800, modelCalls: 2 },
  'pa-e0601-all-met-narrative': { inputTokens: 1300, outputTokens: 900, modelCalls: 2 },
  'pa-e0601-all-met-structured': { inputTokens: 1500, outputTokens: 800, modelCalls: 2 },
  'pa-e0601-ambiguous': { inputTokens: 1200, outputTokens: 800, modelCalls: 2 },
  'pa-e0601-contradicted': { inputTokens: 1400, outputTokens: 800, modelCalls: 2 },
  'pa-e0601-one-missing': { inputTokens: 1400, outputTokens: 800, modelCalls: 2 },
  'pa-k0823-all-met-narrative': { inputTokens: 1400, outputTokens: 1100, modelCalls: 2 },
  'pa-k0823-all-met-structured': { inputTokens: 1600, outputTokens: 1000, modelCalls: 2 },
  'pa-k0823-ambiguous': { inputTokens: 1600, outputTokens: 1100, modelCalls: 2 },
  'pa-k0823-contradicted': { inputTokens: 1600, outputTokens: 1100, modelCalls: 2 },
  'pa-k0823-one-missing': { inputTokens: 1400, outputTokens: 900, modelCalls: 2 },
};
