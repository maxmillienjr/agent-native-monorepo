import {
  pairedBootstrap,
  pairsToResolve,
  type PairedBootstrapResult,
} from '../stats/paired-bootstrap.js';
import { STRATA, wordJaccard, type RetrievalDataset, type Stratum } from './dataset.js';
import {
  DECISION_MARGIN,
  K_VALUES,
  TIE_SALTS,
  applyDecisionRule,
  conditionScores,
  fusionReproduced,
  limitCut,
  provenance,
  queryIndex,
  summarizeCondition,
  type ConditionSummary,
  type Labels,
  type LimitCut,
  type ProvenanceSplit,
  type RawCondition,
  type RuleOutcome,
} from './evaluate.js';

/**
 * The ablation report: every number with the axes and data that produced it.
 *
 * Shaped after the suite report's rule that a number which does not say what
 * produced it is not a measurement. Timestamps and latencies are the only
 * fields that vary between two runs over the same stores and the same
 * embedding file; they live under keys named `startedAt`, `finishedAt` and
 * `latencyMs` so a determinism check can mask exactly those.
 */
export interface AblationReport {
  readonly formatVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly axes: { readonly memory: 'live'; readonly embeddings: 'recorded' | 'live' };
  readonly embeddings: {
    readonly model: string;
    readonly dimensions: number;
    /** From the file's header on the recorded axis; null on the live axis. */
    readonly recordedAt: string | null;
    readonly gitSha: string | null;
  };
  readonly dataset: {
    readonly sha256: string;
    readonly episodes: number;
    readonly facts: number;
    /** Facts no pre-registered label names. */
    readonly distractors: number;
    readonly queries: number;
    readonly perStratum: Readonly<Record<Stratum, number>>;
    /** Mean Jaccard of lowercased word sets, query against each relevant fact. */
    readonly queryLabelOverlap: Readonly<Record<Stratum, number>>;
  };
  readonly config: {
    readonly topK: number;
    readonly hopDepth: number;
    readonly hopDepths: readonly number[];
    readonly ks: readonly number[];
    readonly rrfK: 60;
    readonly bootstrap: {
      readonly resamples: number;
      readonly seed: number;
      readonly confidence: number;
    };
    readonly tieSalts: number;
    readonly margin: number;
  };
  /** `EXPLAIN` of the statement `searchByCosine` ran, from the database. */
  readonly vectorPlan: readonly string[];
  readonly vectorPlanUsesIndex: boolean;
  readonly linker: {
    /** Queries for which the linker produced at least one id. */
    readonly queriesWithIds: number;
    /** Queries for which at least one produced id is a concept in the graph. */
    readonly queriesReachingGraph: number;
  };
  /** Per hybrid condition: did re-fusing the separately read lists reproduce the facade's output? */
  readonly fusionReproduced: Readonly<Record<string, boolean>>;
  /** Per graph-bearing condition: what the graph reader's `LIMIT 50` cut. */
  readonly limitCut: Readonly<Record<string, LimitCut>>;
  readonly labelSets: readonly LabelSetReport[];
  readonly adjudication: AdjudicationSummary | null;
}

export interface AdjudicationSummary {
  /** Who judged the pool. A model, not a person; the report says so and names it. */
  readonly adjudicator: string;
  readonly adjudicatorKind: 'model' | 'person';
  readonly candidates: number;
  readonly judgedRelevant: number;
}

export interface Comparison {
  readonly name: string;
  readonly preRegistered: boolean;
  readonly metric: 'recall@10';
  readonly system: string;
  /** The better of the baselines on this label set's mean Recall@10. */
  readonly baseline: string;
  readonly baselines: readonly string[];
  readonly interval: PairedBootstrapResult;
  /** Pairs a normal interval of this sd would need to separate the point from the margin, and from 0. */
  readonly pairsToResolve: { readonly margin: number | null; readonly zero: number | null };
  /** Null until the rule may be applied; see `buildAblationReport`. */
  readonly outcome: RuleOutcome | null;
  /** The point difference is negative and the whole interval is below 0. */
  readonly loss: boolean | null;
}

export interface LabelSetReport {
  readonly name: 'pre-registered' | 'adjudicated';
  readonly relevantPairs: number;
  readonly conditions: readonly ConditionSummary[];
  readonly provenance: Readonly<
    Record<string, { overall: ProvenanceSplit; perStratum: Record<Stratum, ProvenanceSplit> }>
  >;
  readonly comparisons: readonly Comparison[];
}

export interface AblationInput {
  readonly dataset: RetrievalDataset;
  readonly conditions: readonly RawCondition[];
  readonly labelSets: readonly { readonly name: LabelSetReport['name']; readonly labels: Labels }[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly axes: AblationReport['axes'];
  readonly embeddings: AblationReport['embeddings'];
  readonly vectorPlan: readonly string[];
  readonly linkerIds: ReadonlyMap<string, readonly string[]>;
  readonly goldSeeds: ReadonlyMap<string, readonly string[]>;
  readonly topK: number;
  readonly hopDepth: number;
  readonly hopDepths: readonly number[];
  readonly bootstrap: { readonly resamples: number; readonly seed: number };
  readonly adjudication: AdjudicationSummary | null;
  /**
   * Whether to state the decision rule's outcome. The rule is applied to the
   * pre-registered labels, but only once the adjudicated set exists, so the
   * report that decides ADR 0002 carries both label sets side by side.
   */
  readonly applyRule: boolean;
}

/** The pre-registered comparisons, and one that is reported but decides nothing. */
const COMPARISONS = [
  { name: 'primary', preRegistered: true, system: 'hybrid', baselines: ['vector', 'graph'] },
  {
    name: 'diagnostic: store without the linker',
    preRegistered: true,
    system: 'hybrid·oracle',
    baselines: ['vector', 'graph·oracle'],
  },
  {
    name: 'diagnostic: per-fact MENTIONS',
    preRegistered: false,
    system: 'hybrid·oracle·per-fact',
    baselines: ['vector', 'graph·oracle·per-fact'],
  },
] as const;

export function buildAblationReport(input: AblationInput): AblationReport {
  const { dataset, conditions, topK } = input;
  const index = queryIndex(dataset);
  const byName = new Map(conditions.map((c) => [c.name, c]));

  const preRegistered = new Set(dataset.queries.flatMap((q) => q.relevant));
  const conceptIds = new Set(dataset.entities.keys());

  const labelSets = input.labelSets.map(({ name, labels }): LabelSetReport => {
    const summaries = conditions.map((c) => summarizeCondition(c, labels, index, topK));

    const provenanceByCombo: LabelSetReport['provenance'] = Object.fromEntries(
      conditions
        .filter((c) => c.kind === 'hybrid')
        .map((c) => [c.name, provenance(c, labels, index)] as const)
        .filter(
          (entry): entry is [string, NonNullable<ReturnType<typeof provenance>>] =>
            entry[1] !== null,
        ),
    );

    const comparisons = COMPARISONS.filter(
      (spec) => byName.has(spec.system) && spec.baselines.every((b) => byName.has(b)),
    ).map((spec): Comparison => {
      const recall10 = (conditionName: string): number[] => {
        const scores = conditionScores(byName.get(conditionName)!, labels, topK);
        return dataset.queries.map((q) => scores.get(q.id)?.recall[10] ?? 0);
      };
      const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      // The better baseline by mean; on a tie the first listed, which is `vector`.
      const baseline = [...spec.baselines].sort(
        (a, b) => mean(recall10(b)) - mean(recall10(a)),
      )[0]!;
      const interval = pairedBootstrap(recall10(spec.system), recall10(baseline), input.bootstrap);
      return {
        name: spec.name,
        preRegistered: spec.preRegistered,
        metric: 'recall@10',
        system: spec.system,
        baseline,
        baselines: spec.baselines,
        interval,
        pairsToResolve: {
          margin: pairsToResolve(interval.sd, interval.mean - DECISION_MARGIN),
          zero: pairsToResolve(interval.sd, interval.mean),
        },
        outcome: input.applyRule ? applyDecisionRule(interval) : null,
        loss: input.applyRule ? interval.upper < 0 : null,
      };
    });

    return {
      name,
      relevantPairs: [...labels.values()].reduce((acc, set) => acc + set.size, 0),
      conditions: summaries,
      provenance: provenanceByCombo,
      comparisons,
    };
  });

  const overlap = Object.fromEntries(
    STRATA.map((stratum) => {
      const pairs = dataset.queries
        .filter((q) => q.stratum === stratum)
        .flatMap((q) => q.relevant.map((h) => wordJaccard(q.text, dataset.facts.get(h)!.text)));
      return [stratum, pairs.length === 0 ? 0 : pairs.reduce((a, b) => a + b, 0) / pairs.length];
    }),
  ) as Record<Stratum, number>;

  const seedsFor = (c: RawCondition) => (queryId: string) =>
    (c.seeds === 'gold' ? input.goldSeeds : input.linkerIds).get(queryId) ?? [];

  return {
    formatVersion: 1,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    axes: input.axes,
    embeddings: input.embeddings,
    dataset: {
      sha256: dataset.sha256,
      episodes: dataset.episodes.length,
      facts: dataset.facts.size,
      distractors: [...dataset.facts.keys()].filter((h) => !preRegistered.has(h)).length,
      queries: dataset.queries.length,
      perStratum: Object.fromEntries(
        STRATA.map((s) => [s, dataset.queries.filter((q) => q.stratum === s).length]),
      ) as Record<Stratum, number>,
      queryLabelOverlap: overlap,
    },
    config: {
      topK,
      hopDepth: input.hopDepth,
      hopDepths: input.hopDepths,
      ks: K_VALUES,
      rrfK: 60,
      bootstrap: { ...input.bootstrap, confidence: 0.95 },
      tieSalts: TIE_SALTS.length,
      margin: DECISION_MARGIN,
    },
    vectorPlan: input.vectorPlan,
    vectorPlanUsesIndex: input.vectorPlan.some((line) => /Index Scan using \S*hnsw/i.test(line)),
    linker: {
      queriesWithIds: [...input.linkerIds.values()].filter((ids) => ids.length > 0).length,
      queriesReachingGraph: [...input.linkerIds.values()].filter((ids) =>
        ids.some((id) => conceptIds.has(id)),
      ).length,
    },
    fusionReproduced: Object.fromEntries(
      conditions.filter((c) => c.kind === 'hybrid').map((c) => [c.name, fusionReproduced(c, topK)]),
    ),
    limitCut: Object.fromEntries(
      conditions
        .filter((c) => c.kind === 'graph')
        .map((c) => [c.name, limitCut(dataset, c, seedsFor(c))] as const)
        .filter((entry): entry is [string, LimitCut] => entry[1] !== null),
    ),
    labelSets,
    adjudication: input.adjudication,
  };
}

// --- Rendering -------------------------------------------------------------------------

export function renderAblationJson(report: AblationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const f3 = (x: number): string => x.toFixed(3);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;
const header = (cells: readonly string[]): string =>
  `${row(cells)}\n${row(cells.map((c, i) => (i === 0 ? '---' : '---:')))}`;

function metricsTable(
  conditions: readonly ConditionSummary[],
  pick: (c: ConditionSummary) => ConditionSummary['overall'],
): string {
  const lines = [
    header([
      'Condition',
      ...K_VALUES.map((k) => `R@${k}`),
      ...K_VALUES.map((k) => `nDCG@${k}`),
      'MRR',
    ]),
  ];
  for (const c of conditions) {
    const m = pick(c);
    lines.push(
      row([
        `\`${c.name}\``,
        ...K_VALUES.map((k) => f3(m.recall[k])),
        ...K_VALUES.map((k) => f3(m.ndcg[k])),
        f3(m.mrr),
      ]),
    );
  }
  return lines.join('\n');
}

function operationalTable(conditions: readonly ConditionSummary[]): string {
  const lines = [
    header(['Condition', 'Empty', 'Context chars @10', 'Latency p50 ms', 'Latency p95 ms']),
  ];
  for (const c of conditions) {
    lines.push(
      row([
        `\`${c.name}\``,
        pct(c.emptyFraction),
        c.contextChars.toFixed(0),
        c.latencyMs.p50.toFixed(1),
        c.latencyMs.p95.toFixed(1),
      ]),
    );
  }
  return lines.join('\n');
}

function tieTable(conditions: readonly ConditionSummary[]): string {
  const withRange = conditions.filter((c) => c.tieRange !== null);
  if (withRange.length === 0) return '_No graph-bearing condition._';
  const cell = (value: number, range: readonly [number, number]): string =>
    `${f3(value)} [${f3(range[0])}–${f3(range[1])}]`;
  const lines = [header(['Condition', 'R@1', 'R@10', 'nDCG@10', 'MRR'])];
  for (const c of withRange) {
    const t = c.tieRange!;
    lines.push(
      row([
        `\`${c.name}\``,
        cell(c.overall.recall[1], t.recall[1]),
        cell(c.overall.recall[10], t.recall[10]),
        cell(c.overall.ndcg[10], t.ndcg[10]),
        cell(c.overall.mrr, t.mrr),
      ]),
    );
  }
  return lines.join('\n');
}

function comparisonsTable(comparisons: readonly Comparison[]): string {
  const lines = [
    header([
      'Comparison',
      'System',
      'Better baseline',
      'Δ Recall@10',
      '95% interval',
      'σ',
      'n to clear margin',
      'Outcome',
    ]),
  ];
  for (const c of comparisons) {
    const i = c.interval;
    lines.push(
      row([
        `${c.name}${c.preRegistered ? '' : ' (not pre-registered)'}`,
        `\`${c.system}\``,
        `\`${c.baseline}\``,
        `${i.mean >= 0 ? '+' : ''}${f3(i.mean)}`,
        `[${f3(i.lower)}, ${f3(i.upper)}]`,
        f3(i.sd),
        c.pairsToResolve.margin === null ? '—' : String(c.pairsToResolve.margin),
        c.outcome === null
          ? 'pending adjudication'
          : `${c.outcome}${c.loss === true ? ' (a loss)' : ''}`,
      ]),
    );
  }
  return lines.join('\n');
}

function provenanceTable(split: LabelSetReport['provenance']): string {
  const lines = [
    header([
      'Fused lists of',
      'Stratum',
      'Vector only',
      'Graph only',
      'Both',
      'Neither',
      'Union recall',
    ]),
  ];
  for (const [name, { overall, perStratum }] of Object.entries(split)) {
    for (const [stratum, s] of [
      ['all', overall] as const,
      ...STRATA.map((st) => [st, perStratum[st]] as const),
    ]) {
      lines.push(
        row([
          `\`${name}\``,
          stratum,
          s.vectorOnly,
          s.graphOnly,
          s.both,
          s.neither,
          f3(s.unionRecall),
        ]),
      );
    }
  }
  return lines.join('\n');
}

function strataTable(conditions: readonly ConditionSummary[]): string {
  const lines = [header(['Condition', ...STRATA.map((s) => `R@10 ${s}`)])];
  for (const c of conditions) {
    lines.push(row([`\`${c.name}\``, ...STRATA.map((s) => f3(c.perStratum[s].recall[10]))]));
  }
  return lines.join('\n');
}

export function renderAblationMarkdown(report: AblationReport): string {
  const out: string[] = [];
  const pre = report.labelSets.find((s) => s.name === 'pre-registered')!;
  const adj = report.labelSets.find((s) => s.name === 'adjudicated');
  const primary = pre.conditions.filter((c) => c.table === 'primary');
  const diagnostic = pre.conditions.filter((c) => c.table === 'diagnostic');

  out.push('# Retrieval ablation: graph, vector, hybrid');
  out.push('');
  out.push(
    `- **Axes:** memory \`${report.axes.memory}\`, embeddings \`${report.axes.embeddings}\``,
  );
  out.push(
    `- **Embeddings:** \`${report.embeddings.model}\` at ${report.embeddings.dimensions} dimensions` +
      (report.embeddings.recordedAt === null
        ? ', embedded fresh by this run'
        : `, recorded ${report.embeddings.recordedAt} at \`${report.embeddings.gitSha}\``),
  );
  out.push(`- **Dataset sha256:** \`${report.dataset.sha256}\``);
  out.push(
    `- **Dataset:** ${report.dataset.episodes} episodes, ${report.dataset.facts} facts (${report.dataset.distractors} answer no query), ` +
      `${report.dataset.queries} queries (${STRATA.map((s) => `${s} ${report.dataset.perStratum[s]}`).join(', ')})`,
  );
  out.push(
    `- **Configuration:** topK ${report.config.topK}, hopDepth ${report.config.hopDepth} (diagnostics at ${report.config.hopDepths.join(', ')}), RRF k ${report.config.rrfK}, ` +
      `bootstrap ${report.config.bootstrap.resamples} resamples seed ${report.config.bootstrap.seed}, ${report.config.tieSalts} tie salts`,
  );
  out.push(
    `- **Vector search:** ${report.vectorPlanUsesIndex ? 'served by the HNSW index' : 'a sequential scan — the plan below does not use the HNSW index (ADR 0006), and every latency here is for that scan'}`,
  );
  out.push(
    `- **Seed linker:** produced ids for ${report.linker.queriesWithIds} of ${report.dataset.queries} queries; ` +
      `${report.linker.queriesReachingGraph} produced an id that is a concept in the graph`,
  );
  out.push(
    report.adjudication === null
      ? '- **Labels:** pre-registered only; the pooled candidates have not been adjudicated'
      : `- **Labels:** pre-registered, and adjudicated by ${report.adjudication.adjudicator} (a ${report.adjudication.adjudicatorKind}, not a domain expert): ` +
          `${report.adjudication.judgedRelevant} of ${report.adjudication.candidates} pooled candidates judged relevant`,
  );
  out.push('');

  out.push('## Primary table — the deployed path, pre-registered labels');
  out.push('');
  out.push(
    'Overall, over all queries (unweighted). The per-stratum tables below are the ones to trust.',
  );
  out.push('');
  out.push(metricsTable(primary, (c) => c.overall));
  out.push('');
  for (const stratum of STRATA) {
    out.push(`### ${stratum}`);
    out.push('');
    out.push(metricsTable(primary, (c) => c.perStratum[stratum]));
    out.push('');
  }

  out.push('## Decision rule');
  out.push('');
  out.push(
    `Pre-registered in P2-B: \`hybrid\` against the better of \`vector\` and \`graph\` on Recall@10 over all queries, pre-registered labels. ` +
      `It earns its keep at Δ ≥ +${report.config.margin} with the interval's lower bound above 0; it does not if the upper bound is below +${report.config.margin}; otherwise inconclusive.`,
  );
  out.push('');
  out.push(comparisonsTable(pre.comparisons));
  out.push('');

  out.push('## Diagnostic table — pre-registered labels');
  out.push('');
  out.push(metricsTable(diagnostic, (c) => c.overall));
  out.push('');
  out.push('Recall@10 per stratum, every condition:');
  out.push('');
  out.push(strataTable(pre.conditions));
  out.push('');

  out.push('## Where relevant facts were found');
  out.push('');
  out.push(
    "Each relevant (query, fact) pair, by which of the two lists the facade fuses held it — pgvector at 2 × topK and the graph reader's full list. " +
      '`Graph only` is what the graph found that the vector path did not. `Union recall` is the ceiling fusion could reach.',
  );
  out.push('');
  out.push(provenanceTable(pre.provenance));
  out.push('');

  out.push('## Operational');
  out.push('');
  out.push(operationalTable(pre.conditions));
  out.push('');

  out.push('## Tie sensitivity');
  out.push('');
  out.push(
    `The graph orders facts at one hop distance by content hash. Each graph list's ties were re-sorted under ${report.config.tieSalts} fixed salts and re-fused with \`rrfMerge\`; ` +
      'the value is at the production tie-break, the range is min–max over the salts.',
  );
  out.push('');
  out.push(tieTable(pre.conditions));
  out.push('');
  out.push(
    `Re-fusion reproduces the facade's output: ${Object.entries(report.fusionReproduced)
      .map(([name, ok]) => `\`${name}\` ${ok ? 'yes' : 'NO'}`)
      .join(', ')}.`,
  );
  out.push('');
  out.push("What the graph reader's `LIMIT 50` cut, computed from the corpus:");
  out.push('');
  out.push(
    header([
      'Condition',
      'Queries at limit',
      'Facts cut',
      'Tied at the cut',
      'Store agrees with corpus',
    ]),
  );
  for (const [name, cut] of Object.entries(report.limitCut)) {
    out.push(
      row([
        `\`${name}\``,
        cut.queriesAtLimit,
        cut.factsCut,
        cut.tiedAtCut,
        `${cut.storeAgrees} / ${cut.queries}`,
      ]),
    );
  }
  out.push('');

  out.push('## Query–label overlap');
  out.push('');
  out.push('Mean Jaccard over lowercased word sets, query against each relevant fact:');
  out.push('');
  out.push(header(['Stratum', 'Overlap']));
  for (const stratum of STRATA)
    out.push(row([stratum, f3(report.dataset.queryLabelOverlap[stratum])]));
  out.push('');

  if (adj !== undefined) {
    out.push('## Adjudicated labels');
    out.push('');
    out.push(`${adj.relevantPairs} relevant pairs against ${pre.relevantPairs} pre-registered.`);
    out.push('');
    out.push(
      metricsTable(
        adj.conditions.filter((c) => c.table === 'primary'),
        (c) => c.overall,
      ),
    );
    out.push('');
    out.push(comparisonsTable(adj.comparisons));
    out.push('');
    out.push(strataTable(adj.conditions));
    out.push('');
  }

  out.push('## Vector query plan');
  out.push('');
  out.push('```');
  out.push(...report.vectorPlan);
  out.push('```');
  out.push('');

  return out.join('\n');
}
