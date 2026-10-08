import { AGENT_NATIVE, GEN_AI, GEN_AI_OPERATION } from '@repo/telemetry/genai';
import {
  BUDGET_NAMES,
  type Axes,
  type BudgetName,
  type BudgetResult,
  type Budgets,
  type CostEstimate,
  type PriceTable,
  type SpanRecord,
  type Transcript,
  type TrialUsage,
} from './types.js';

/**
 * Budgets, usage and cost, read from a trial's own spans (P1-F).
 *
 * Every figure here comes from `Transcript.spans`, which P2-C filters to the
 * trial's trace, so nothing another trial or the harness did is summed in. The
 * attribute names come from `@repo/telemetry/genai` and are never spelled out.
 */

const operationOf = (span: SpanRecord): unknown => span.attributes[GEN_AI.OPERATION_NAME];
const isChat = (span: SpanRecord): boolean =>
  operationOf(span) === GEN_AI_OPERATION.GENERATE_CONTENT;
const isEmbedding = (span: SpanRecord): boolean =>
  operationOf(span) === GEN_AI_OPERATION.EMBEDDINGS;
const isReplayed = (span: SpanRecord): boolean => span.attributes[AGENT_NATIVE.REPLAYED] === true;
const isErrored = (span: SpanRecord): boolean => span.status === 'error';

function count(span: SpanRecord, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The sum of one usage key over the successful calls, or `null` when any of
 * them lacks it. An errored call made a request and carries no usage, so it
 * does not make the sum unknowable; a successful call with no count does.
 */
function sumOver(calls: readonly SpanRecord[], key: string): number | null {
  let total = 0;
  for (const span of calls) {
    if (isErrored(span)) continue;
    const value = count(span, key);
    if (value === undefined) return null;
    total += value;
  }
  return total;
}

function sourceOf(calls: readonly SpanRecord[]): TrialUsage['source'] {
  if (calls.length === 0) return 'none';
  const replayed = calls.filter(isReplayed).length;
  if (replayed === calls.length) return 'recorded';
  if (replayed === 0) return 'measured';
  return 'mixed';
}

/**
 * A list-price equivalent of the trial's chat calls.
 *
 * Priced per `gen_ai.request.model`. A model the table does not list is named
 * as unpriced and contributes nothing — never a zero that reads as free. The
 * embedding API reports no usage, so its calls are counted and never priced.
 */
export function estimateCost(
  spans: readonly SpanRecord[],
  prices: PriceTable | undefined,
): CostEstimate {
  const calls = spans.filter(isChat);
  const unpriced = new Set<string>();
  let usd = 0;
  let priced = 0;

  const byModel = new Map<string, SpanRecord[]>();
  for (const span of calls) {
    const model = String(span.attributes[GEN_AI.REQUEST_MODEL] ?? '');
    byModel.set(model, [...(byModel.get(model) ?? []), span]);
  }

  for (const [model, modelCalls] of byModel) {
    const row = prices?.models[model];
    const input = sumOver(modelCalls, GEN_AI.USAGE_INPUT_TOKENS);
    const output = sumOver(modelCalls, GEN_AI.USAGE_OUTPUT_TOKENS);
    if (row === undefined || input === null || output === null) {
      unpriced.add(model === '' ? '(no model named)' : model);
      continue;
    }
    usd += (input * row.inputUsdPerMTok + output * row.outputUsdPerMTok) / 1_000_000;
    priced += 1;
  }

  return {
    usd: priced === 0 ? null : usd,
    unpricedModels: [...unpriced].sort(),
    unpricedEmbeddingCalls: spans.filter(isEmbedding).length,
  };
}

/** What one trial used, from its spans. */
export function trialUsage(
  taskId: string,
  index: number,
  transcript: Transcript,
  prices?: PriceTable,
): TrialUsage {
  const spans = transcript.spans ?? [];
  const calls = spans.filter(isChat);
  const source = sourceOf(calls);
  const timed = spans.filter((span) => isChat(span) || isEmbedding(span));

  return {
    taskId,
    index,
    source,
    modelCalls: calls.length,
    erroredModelCalls: calls.filter(isErrored).length,
    inputTokens: calls.length === 0 ? null : sumOver(calls, GEN_AI.USAGE_INPUT_TOKENS),
    outputTokens: calls.length === 0 ? null : sumOver(calls, GEN_AI.USAGE_OUTPUT_TOKENS),
    reasoningTokens: calls.reduce(
      (total, span) => total + (count(span, GEN_AI.USAGE_REASONING_OUTPUT_TOKENS) ?? 0),
      0,
    ),
    embeddingCalls: spans.filter(isEmbedding).length,
    // Only when every timed span is a real call. A replayed span's duration
    // is replay speed, and a figure that summed some of each would be neither.
    modelLatencyMs:
      source === 'measured' && !timed.some(isReplayed)
        ? timed.reduce((total, span) => total + span.durationMs, 0)
        : null,
    cost: estimateCost(spans, prices),
  };
}

const DESCRIBE: Readonly<Record<BudgetName, string>> = {
  inputTokens: 'input tokens',
  outputTokens: 'output tokens (thinking included)',
  modelCalls: 'generate_content calls',
};

/**
 * The task's budgets, checked against one trial.
 *
 * Returns nothing on `model=stub`, which opens no inference span; the report
 * says so where it lists skipped tasks. Everywhere else the rules are:
 *
 * - **Absent is not zero.** No inference span at all, or a successful
 *   `generate_content` span with no usage count, makes the affected budgets
 *   `unmeasurable`, which counts as a breach.
 * - **Errored spans** count toward `modelCalls`, because the request was made,
 *   and carry no usage. They do not make a trial unmeasurable.
 * - **Replayed or measured, never mixed.** A trial whose inference spans are
 *   partly replayed is unmeasurable on every budget.
 */
export function checkBudgets(
  transcript: Transcript,
  budgets: Budgets | undefined,
  axes: Axes,
): BudgetResult[] {
  if (budgets === undefined || axes.model === 'stub') return [];

  const usage = trialUsage('', 0, transcript);
  const declared = BUDGET_NAMES.flatMap((name) => {
    const limit = budgets[name];
    return limit === undefined ? [] : [{ name, limit }];
  });

  return declared.map(({ name, limit }): BudgetResult => {
    const unmeasurable = (explanation: string): BudgetResult => ({
      budget: name,
      limit,
      actual: null,
      label: 'unmeasurable',
      explanation,
    });

    if (transcript.spans === undefined) {
      return unmeasurable('the transcript carries no spans, so nothing it used can be read');
    }
    if (usage.source === 'none') {
      return unmeasurable(
        `no generate_content span on model=${axes.model}: a run there makes at least one ` +
          'model call, so its spans were not collected',
      );
    }
    if (usage.source === 'mixed') {
      return unmeasurable(
        'some inference spans are replayed and some are not, so the figure is neither the ' +
          "recording's nor a measurement",
      );
    }

    const actual =
      name === 'modelCalls'
        ? usage.modelCalls
        : name === 'inputTokens'
          ? usage.inputTokens
          : usage.outputTokens;
    if (actual === null) {
      return {
        ...unmeasurable(
          `a successful generate_content span carries no ${DESCRIBE[name]} count; absent is ` +
            'not zero',
        ),
        source: usage.source,
      };
    }

    const within = actual <= limit;
    return {
      budget: name,
      limit,
      actual,
      label: within ? 'within' : 'breached',
      source: usage.source,
      explanation:
        `${actual} ${DESCRIBE[name]} against a ceiling of ${limit}` +
        (usage.source === 'recorded' ? ', as recorded in the cassette' : '') +
        (within ? '' : `: over by ${actual - limit}`),
    };
  });
}
