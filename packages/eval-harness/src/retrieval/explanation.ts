import {
  pairedBootstrap,
  pairsToResolve,
  type PairedBootstrapResult,
} from '../stats/paired-bootstrap.js';
import { STRATA, type RetrievalDataset, type Stratum } from './dataset.js';
import { pathKey, type ExplanationPair, type GoldPath } from './explanation-labels.js';

/**
 * P2-D's arithmetic: path precision and recall per (query, fact) pair, their
 * intervals, the pre-registered rule and the report.
 *
 * Pure functions. The runner in `apps/agent-service` reads the graph and
 * hands the returned paths in; nothing here knows what a store is.
 */

/** A path as the explainer returns it. Structurally `ConceptPath` in memory-core. */
export interface ReturnedPath {
  readonly concepts: readonly string[];
  readonly edgeTypes: readonly string[];
}

/** The cut the explainer applies, and the denominator of recall@3. */
export const PATHS_AT = 3;

/** Stage 1's thresholds, agreed at review on 2026-10-08 before any number existed. */
export const STAGE1_THRESHOLDS = { recall: 0.7, precision: 0.5 } as const;
/** Stage 2's margin on `answer_key_present`, `with` − `without`. */
export const STAGE2_MARGIN = 0.1;

// --- Matching and per-pair scores -------------------------------------------------

const reversed = (path: ReturnedPath): ReturnedPath => ({
  concepts: [...path.concepts].reverse(),
  edgeTypes: [...path.edgeTypes].reverse(),
});

/** A returned path matches a gold one when concepts and edge types are equal in either direction. */
export function pathsMatch(returned: ReturnedPath, gold: GoldPath): boolean {
  const key = pathKey(gold);
  return pathKey(returned) === key || pathKey(reversed(returned)) === key;
}

export interface PairScore {
  /** |R ∩ G| / |R|; 0 when R is empty and G is not; null when both are empty. */
  readonly precision: number | null;
  /** |R ∩ G| / min(|G|, 3); null when G is empty. */
  readonly recall: number | null;
  /** Whether the first path is gold; null when G is empty. Reported only. */
  readonly hit1: number | null;
  /** R is empty. Reported only, and read on `no-entity` pairs. */
  readonly abstained: boolean;
}

export function scorePair(returned: readonly ReturnedPath[], gold: readonly GoldPath[]): PairScore {
  const isGold = (path: ReturnedPath): boolean => gold.some((g) => pathsMatch(path, g));
  const matched = returned.filter(isGold).length;
  const first = returned[0];
  return {
    precision: returned.length > 0 ? matched / returned.length : gold.length > 0 ? 0 : null,
    recall: gold.length > 0 ? matched / Math.min(gold.length, PATHS_AT) : null,
    hit1: gold.length > 0 ? (first !== undefined && isGold(first) ? 1 : 0) : null,
    abstained: returned.length === 0,
  };
}

// --- Summaries ------------------------------------------------------------------------

export interface BootstrapOptions {
  readonly resamples: number;
  readonly seed: number;
}

export interface MetricSummary {
  /** Pairs on which the metric is defined. */
  readonly n: number;
  readonly mean: number | null;
  readonly sd: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  /**
   * The pairs a normal-approximation interval at this sd would need to put the
   * mean clearly on one side of the stage-1 threshold. Null for a metric with
   * no threshold (Hit@1), or when the metric is undefined on every pair.
   */
  readonly pairsToResolve: number | null;
}

/**
 * The mean of the defined values, with `pairedBootstrap(values, zeros)` as its
 * interval, and `pairsToResolve` against `threshold` when one is given.
 */
export function summarizeMetric(
  values: readonly (number | null)[],
  bootstrap: BootstrapOptions,
  threshold?: number,
): MetricSummary {
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) {
    return { n: 0, mean: null, sd: null, lower: null, upper: null, pairsToResolve: null };
  }
  const interval = pairedBootstrap(
    defined,
    defined.map(() => 0),
    bootstrap,
  );
  return {
    n: interval.n,
    mean: interval.mean,
    sd: interval.sd,
    lower: interval.lower,
    upper: interval.upper,
    pairsToResolve:
      threshold === undefined ? null : pairsToResolve(interval.sd, interval.mean - threshold),
  };
}

export interface StratumSummary {
  readonly pairs: number;
  readonly precision: MetricSummary;
  readonly recall: MetricSummary;
  readonly hit1: MetricSummary;
  /** Fraction of pairs with no path returned. */
  readonly abstention: number;
}

export interface PairResult {
  readonly queryId: string;
  readonly factHandle: string;
  readonly stratum: Stratum;
  /** The ids the condition's question linker gave the explainer. */
  readonly questionConcepts: readonly string[];
  /** `pathKey` of each returned path, in the explainer's order. */
  readonly returned: readonly string[];
  readonly score: PairScore;
}

export type QuestionConceptSource = 'linker' | 'gold';
export type ExplanationGraphShape = 'reflect' | 'per-fact';

export interface RawExplanationCondition {
  readonly name: string;
  readonly role: 'decisive' | 'diagnostic' | 'construction check';
  readonly graphShape: ExplanationGraphShape;
  readonly questionConcepts: QuestionConceptSource;
  /** One per labelled pair, in label order. */
  readonly pairs: readonly {
    readonly pair: ExplanationPair;
    readonly questionConcepts: readonly string[];
    readonly returned: readonly ReturnedPath[];
  }[];
}

export interface ConditionDiagnostics {
  /** Relational pairs whose question concepts include the gold seed A. */
  readonly relationalLinkedA: number;
  /** Relational pairs with a length-0 path among those returned: the fact is linked to A itself. */
  readonly relationalWithDirectMention: number;
  /** Relational pairs whose first path is length 0. */
  readonly relationalDirectMentionFirst: number;
}

export interface ConditionReport {
  readonly name: string;
  readonly role: RawExplanationCondition['role'];
  readonly graphShape: ExplanationGraphShape;
  readonly questionConcepts: QuestionConceptSource;
  readonly perStratum: Readonly<Record<Stratum, StratumSummary>>;
  readonly diagnostics: ConditionDiagnostics;
  readonly pairs: readonly PairResult[];
}

export function summarizeExplanationCondition(
  dataset: RetrievalDataset,
  condition: RawExplanationCondition,
  bootstrap: BootstrapOptions,
): ConditionReport {
  const strata = new Map(dataset.queries.map((q) => [q.id, q.stratum]));
  const goldSeeds = new Map(dataset.queries.map((q) => [q.id, q.goldSeeds]));

  const pairs: PairResult[] = condition.pairs.map(({ pair, questionConcepts, returned }) => ({
    queryId: pair.queryId,
    factHandle: pair.factHandle,
    stratum: strata.get(pair.queryId)!,
    questionConcepts: [...questionConcepts],
    returned: returned.map(pathKey),
    score: scorePair(returned, pair.gold),
  }));

  const perStratum = Object.fromEntries(
    STRATA.map((stratum) => {
      const scores = pairs.filter((p) => p.stratum === stratum).map((p) => p.score);
      return [
        stratum,
        {
          pairs: scores.length,
          precision: summarizeMetric(
            scores.map((s) => s.precision),
            bootstrap,
            STAGE1_THRESHOLDS.precision,
          ),
          recall: summarizeMetric(
            scores.map((s) => s.recall),
            bootstrap,
            STAGE1_THRESHOLDS.recall,
          ),
          hit1: summarizeMetric(
            scores.map((s) => s.hit1),
            bootstrap,
          ),
          abstention:
            scores.length === 0 ? 0 : scores.filter((s) => s.abstained).length / scores.length,
        } satisfies StratumSummary,
      ];
    }),
  ) as Record<Stratum, StratumSummary>;

  const relational = condition.pairs.filter((p) => strata.get(p.pair.queryId) === 'relational');
  const isDirect = (path: ReturnedPath): boolean => path.edgeTypes.length === 0;
  const diagnostics: ConditionDiagnostics = {
    relationalLinkedA: relational.filter((p) =>
      (goldSeeds.get(p.pair.queryId) ?? []).some((a) => p.questionConcepts.includes(a)),
    ).length,
    relationalWithDirectMention: relational.filter((p) => p.returned.some(isDirect)).length,
    relationalDirectMentionFirst: relational.filter(
      (p) => p.returned[0] !== undefined && isDirect(p.returned[0]),
    ).length,
  };

  return {
    name: condition.name,
    role: condition.role,
    graphShape: condition.graphShape,
    questionConcepts: condition.questionConcepts,
    perStratum,
    diagnostics,
    pairs,
  };
}

// --- The construction check -------------------------------------------------------------

export interface ConstructionCheck {
  readonly condition: string;
  /** Mean of each relational pair's recall bound, min(|G|, 3) / min(|G|, 3) for a non-empty G. */
  readonly bound: number;
  readonly recall: number | null;
  readonly passed: boolean;
  /** Relational pairs below their own bound, as `queryId/factHandle`. */
  readonly failures: readonly string[];
}

/**
 * On relational pairs, the per-fact graph with gold question concepts must
 * reach every pair's recall bound. The per-fact graph is built from the same
 * `mentions` the gold is derived from, so anything less is a defect in the
 * explainer, not a finding. The bound is 1 for every pair with gold, because
 * recall's denominator is already capped at three; it is computed rather than
 * assumed so that a label set with an empty relational gold cannot pass.
 */
export function constructionCheck(condition: ConditionReport): ConstructionCheck {
  const relational = condition.pairs.filter((p) => p.stratum === 'relational');
  const bounds = relational.map((p): number => (p.score.recall === null ? 0 : 1));
  const bound = bounds.length === 0 ? 0 : bounds.reduce((a, b) => a + b, 0) / bounds.length;
  const failures = relational
    .filter((p) => p.score.recall === null || p.score.recall < 1)
    .map((p) => `${p.queryId}/${p.factHandle}`);
  const recall = condition.perStratum.relational.recall.mean;
  return {
    condition: condition.name,
    bound,
    recall,
    passed: relational.length > 0 && failures.length === 0 && recall === bound,
    failures,
  };
}

// --- The decision rule ---------------------------------------------------------------------

export type Stage1Outcome = 'good' | 'not good' | 'inconclusive';
export type Stage2Outcome = 'met' | 'not met';
export type ExplanationOutcome = 'keep the graph for explanation' | 'option C';

export interface Interval {
  readonly mean: number;
  readonly sd: number;
  readonly lower: number;
  readonly upper: number;
}

/**
 * Stage 1, pre-registered in P2-D, on `explain`'s relational stratum:
 *
 * - `good` if recall@3's lower bound is at least 0.70 and precision@3's is at
 *   least 0.50;
 * - `not good` if either upper bound is below its threshold;
 * - `inconclusive` otherwise, never rounded toward either side.
 */
export function applyExplanationRule(recall: Interval, precision: Interval): Stage1Outcome {
  if (recall.lower >= STAGE1_THRESHOLDS.recall && precision.lower >= STAGE1_THRESHOLDS.precision) {
    return 'good';
  }
  if (recall.upper < STAGE1_THRESHOLDS.recall || precision.upper < STAGE1_THRESHOLDS.precision) {
    return 'not good';
  }
  return 'inconclusive';
}

/** Stage 2: `with` − `without` on `answer_key_present` is at least +0.10 and its lower bound is above 0. */
export function applyAnswerRule(difference: PairedBootstrapResult): Stage2Outcome {
  return difference.mean >= STAGE2_MARGIN && difference.lower > 0 ? 'met' : 'not met';
}

/**
 * The row of P2-D's outcome table. Only `good` then `met` keeps the graph;
 * `inconclusive` selects C, because ADR 0009's condition is that the
 * measurement meets its rule and an inconclusive one does not.
 */
export function explanationOutcome(
  stage1: Stage1Outcome,
  stage2: Stage2Outcome | null,
): ExplanationOutcome {
  if (stage1 === 'good' && stage2 === 'met') return 'keep the graph for explanation';
  return 'option C';
}

export interface Stage1Decision {
  readonly condition: string;
  readonly stratum: 'relational';
  readonly recall: Interval & { readonly n: number };
  readonly precision: Interval & { readonly n: number };
  readonly outcome: Stage1Outcome;
  /**
   * For `inconclusive`: the pairs each unresolved metric's interval would need
   * to clear its threshold, at this sd. Null for a metric that is resolved.
   */
  readonly pairsToResolve: { readonly recall: number | null; readonly precision: number | null };
}

const asInterval = (m: MetricSummary): Interval & { n: number } => ({
  n: m.n,
  mean: m.mean ?? 0,
  sd: m.sd ?? 0,
  lower: m.lower ?? 0,
  upper: m.upper ?? 0,
});

export function decideStage1(decisive: ConditionReport): Stage1Decision {
  const recall = asInterval(decisive.perStratum.relational.recall);
  const precision = asInterval(decisive.perStratum.relational.precision);
  const outcome = applyExplanationRule(recall, precision);
  const unresolved = (i: Interval, threshold: number): number | null =>
    outcome === 'inconclusive' && i.lower < threshold && i.upper >= threshold
      ? pairsToResolve(i.sd, i.mean - threshold)
      : null;
  return {
    condition: decisive.name,
    stratum: 'relational',
    recall,
    precision,
    outcome,
    pairsToResolve: {
      recall: unresolved(recall, STAGE1_THRESHOLDS.recall),
      precision: unresolved(precision, STAGE1_THRESHOLDS.precision),
    },
  };
}

// --- The report ----------------------------------------------------------------------------

/**
 * Everything one `yarn eval:explanation` run produced, with what produced it.
 * As in the ablation report, the only fields that vary between two runs over
 * the same stores are `startedAt` and `finishedAt`; the explainer's reads
 * are not timed, so there is no latency to mask.
 */
export interface ExplanationReport {
  readonly formatVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Stage 1 reads the graph and calls no model and no embedder. */
  readonly axes: { readonly memory: 'live'; readonly model: 'none'; readonly embeddings: 'none' };
  readonly dataset: {
    readonly sha256: string;
    readonly labelsSha256: string;
    readonly pairs: number;
    readonly perStratum: Readonly<Record<Stratum, number>>;
  };
  readonly config: {
    readonly pathsAt: number;
    readonly maxHops: number;
    readonly thresholds: typeof STAGE1_THRESHOLDS;
    readonly stage2Margin: number;
    readonly bootstrap: BootstrapOptions & { readonly confidence: 0.95 };
  };
  readonly construction: ConstructionCheck & {
    /** Whether the explainer was changed after the first measured run. The PRD allows it once, here. */
    readonly explainerChangedAfterFirstRun: boolean;
  };
  /** Empty when the construction check failed: no other condition is printed then. */
  readonly conditions: readonly ConditionReport[];
  readonly stage1: Stage1Decision | null;
  readonly stage2: {
    readonly ran: boolean;
    readonly generateContentCalls: number;
    readonly reason: string;
  };
  readonly outcome: ExplanationOutcome | null;
}

export interface ExplanationReportInput {
  readonly dataset: RetrievalDataset;
  readonly labelsSha256: string;
  readonly pairs: number;
  readonly conditions: readonly RawExplanationCondition[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly maxHops: number;
  readonly bootstrap: BootstrapOptions;
  readonly explainerChangedAfterFirstRun: boolean;
  /** The condition whose relational recall must reach its bound before anything else is printed. */
  readonly constructionCondition: string;
  /** The condition the rule reads. */
  readonly decisiveCondition: string;
}

export function buildExplanationReport(input: ExplanationReportInput): ExplanationReport {
  const summaries = input.conditions.map((c) =>
    summarizeExplanationCondition(input.dataset, c, input.bootstrap),
  );
  const check = constructionCheck(summaries.find((c) => c.name === input.constructionCondition)!);
  const decisive = summaries.find((c) => c.name === input.decisiveCondition)!;
  const stage1 = check.passed ? decideStage1(decisive) : null;
  const perStratum = Object.fromEntries(
    STRATA.map((s) => [s, summaries[0]?.pairs.filter((p) => p.stratum === s).length ?? 0]),
  ) as Record<Stratum, number>;

  return {
    formatVersion: 1,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    axes: { memory: 'live', model: 'none', embeddings: 'none' },
    dataset: {
      sha256: input.dataset.sha256,
      labelsSha256: input.labelsSha256,
      pairs: input.pairs,
      perStratum,
    },
    config: {
      pathsAt: PATHS_AT,
      maxHops: input.maxHops,
      thresholds: STAGE1_THRESHOLDS,
      stage2Margin: STAGE2_MARGIN,
      bootstrap: { ...input.bootstrap, confidence: 0.95 },
    },
    construction: { ...check, explainerChangedAfterFirstRun: input.explainerChangedAfterFirstRun },
    conditions: check.passed ? summaries : [],
    stage1,
    stage2:
      stage1 === null
        ? {
            ran: false,
            generateContentCalls: 0,
            reason: 'the construction check failed, so no condition was scored',
          }
        : stage1.outcome === 'good'
          ? {
              ran: false,
              generateContentCalls: 0,
              reason:
                'stage 1 is good; stage 2 is scheduled separately against the free-tier quota and has not run',
            }
          : {
              ran: false,
              generateContentCalls: 0,
              reason: `stage 1 is ${stage1.outcome}, so the rule does not run stage 2`,
            },
    outcome:
      stage1 === null
        ? null
        : stage1.outcome === 'good'
          ? null // decided by stage 2
          : explanationOutcome(stage1.outcome, null),
  };
}

// --- Rendering -------------------------------------------------------------------------------

export function renderExplanationJson(report: ExplanationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const f3 = (x: number | null): string => (x === null ? '—' : x.toFixed(3));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;
const header = (cells: readonly string[]): string =>
  `${row(cells)}\n${row(cells.map((c, i) => (i === 0 ? '---' : '---:')))}`;
const withInterval = (m: MetricSummary): string =>
  m.mean === null ? '—' : `${f3(m.mean)} [${f3(m.lower)}, ${f3(m.upper)}]`;

function stratumTable(conditions: readonly ConditionReport[], stratum: Stratum): string {
  const lines = [
    header([
      'Condition',
      'Pairs',
      'Precision@3',
      'Recall@3',
      'Hit@1',
      'n P / R',
      'sd P / R',
      'To resolve P / R',
      'Abstained',
    ]),
  ];
  for (const c of conditions) {
    const s = c.perStratum[stratum];
    lines.push(
      row([
        `\`${c.name}\``,
        s.pairs,
        withInterval(s.precision),
        withInterval(s.recall),
        withInterval(s.hit1),
        `${s.precision.n} / ${s.recall.n}`,
        `${f3(s.precision.sd)} / ${f3(s.recall.sd)}`,
        `${s.precision.pairsToResolve ?? '—'} / ${s.recall.pairsToResolve ?? '—'}`,
        pct(s.abstention),
      ]),
    );
  }
  return lines.join('\n');
}

export function renderExplanationMarkdown(report: ExplanationReport): string {
  const out: string[] = [];
  out.push('# Graph explanation: path precision and recall');
  out.push('');
  out.push(
    `- **Axes:** memory \`${report.axes.memory}\`, model \`${report.axes.model}\`, embeddings \`${report.axes.embeddings}\``,
  );
  out.push(`- **Dataset sha256:** \`${report.dataset.sha256}\``);
  out.push(`- **Labels sha256:** \`${report.dataset.labelsSha256}\` (\`explanation-labels.json\`)`);
  out.push(
    `- **Pairs:** ${report.dataset.pairs} (${STRATA.map((s) => `${s} ${report.dataset.perStratum[s]}`).join(', ')})`,
  );
  out.push(
    `- **Configuration:** at most ${report.config.pathsAt} paths per fact, at most ${report.config.maxHops} hops, ` +
      `bootstrap ${report.config.bootstrap.resamples} resamples seed ${report.config.bootstrap.seed}, 95% percentile`,
  );
  out.push(`- **Run:** ${report.startedAt} to ${report.finishedAt}`);
  out.push('');

  const c = report.construction;
  out.push('## Construction check');
  out.push('');
  out.push(
    `\`${c.condition}\` on relational pairs: recall@3 ${f3(c.recall)} against a bound of ${f3(c.bound)}: **${c.passed ? 'passed' : 'failed'}**. ` +
      `The explainer ${c.explainerChangedAfterFirstRun ? 'was' : 'was not'} changed after the first run.`,
  );
  if (c.failures.length > 0) {
    out.push('');
    out.push(`Pairs below their bound: ${c.failures.map((f) => `\`${f}\``).join(', ')}.`);
  }
  out.push('');
  if (!c.passed) {
    out.push('The explainer has a defect. No other condition is printed.');
    return `${out.join('\n')}\n`;
  }

  out.push('## Conditions');
  out.push('');
  out.push(
    header(['Condition', 'Role', 'Graph shape', 'Question concepts']) +
      '\n' +
      report.conditions
        .map((x) =>
          row([`\`${x.name}\``, x.role, `\`${x.graphShape}\``, `\`${x.questionConcepts}\``]),
        )
        .join('\n'),
  );
  out.push('');
  for (const stratum of STRATA) {
    out.push(`### ${stratum}`);
    out.push('');
    out.push(stratumTable(report.conditions, stratum));
    out.push('');
  }

  out.push('### Relational diagnostics');
  out.push('');
  out.push(
    header([
      'Condition',
      'A among question concepts',
      'Length-0 path returned',
      'Length-0 path first',
    ]) +
      '\n' +
      report.conditions
        .map((x) =>
          row([
            `\`${x.name}\``,
            `${x.diagnostics.relationalLinkedA} / ${x.perStratum.relational.pairs}`,
            `${x.diagnostics.relationalWithDirectMention} / ${x.perStratum.relational.pairs}`,
            `${x.diagnostics.relationalDirectMentionFirst} / ${x.perStratum.relational.pairs}`,
          ]),
        )
        .join('\n'),
  );
  out.push('');

  const s1 = report.stage1!;
  out.push('## Decision rule');
  out.push('');
  out.push(
    `Pre-registered in P2-D, on \`${s1.condition}\`, relational stratum: \`good\` if recall@3's 95% lower bound is at least ${report.config.thresholds.recall} ` +
      `and precision@3's is at least ${report.config.thresholds.precision}; \`not good\` if either upper bound is below its threshold; otherwise \`inconclusive\`.`,
  );
  out.push('');
  out.push(header(['Metric', 'n', 'Mean', '95% interval', 'sd', 'Threshold', 'Pairs to resolve']));
  out.push(
    row([
      'Recall@3',
      s1.recall.n,
      f3(s1.recall.mean),
      `[${f3(s1.recall.lower)}, ${f3(s1.recall.upper)}]`,
      f3(s1.recall.sd),
      report.config.thresholds.recall.toFixed(2),
      s1.pairsToResolve.recall ?? '—',
    ]),
  );
  out.push(
    row([
      'Precision@3',
      s1.precision.n,
      f3(s1.precision.mean),
      `[${f3(s1.precision.lower)}, ${f3(s1.precision.upper)}]`,
      f3(s1.precision.sd),
      report.config.thresholds.precision.toFixed(2),
      s1.pairsToResolve.precision ?? '—',
    ]),
  );
  out.push('');
  out.push(`**Stage 1: ${s1.outcome}.**`);
  out.push('');
  out.push(
    `**Stage 2: ${report.stage2.ran ? 'ran' : 'did not run'}** — ${report.stage2.reason}. ` +
      `It made ${report.stage2.generateContentCalls} \`generateContent\` calls.`,
  );
  out.push('');
  out.push(
    report.outcome === null
      ? '**Outcome: decided by stage 2.**'
      : `**Outcome: ${report.outcome}.**`,
  );
  return `${out.join('\n')}\n`;
}
