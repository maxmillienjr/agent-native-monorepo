import { pairedBootstrap, type PairedBootstrapResult } from '../stats/paired-bootstrap.js';
import {
  answerKeyPresent,
  normalizeAnswerText,
  type ExplanationPair,
} from './explanation-labels.js';
import {
  STAGE2_MARGIN,
  applyAnswerRule,
  type BootstrapOptions,
  type Stage2Outcome,
} from './explanation.js';

/**
 * P2-D's stage 2: does `plan` answer better with the graph's paths in its
 * prompt than without them?
 *
 * The graders, the paired comparison, the rule and the report. Pure
 * functions: the runner in `apps/agent-service` builds the two prompts, gets
 * the answers from the answer file it records or replays, and hands them in.
 * Nothing here knows what a model or a store is.
 */

/** The two conditions, in the order the recorder asks them for each query. */
export const STAGE2_CONDITIONS = ['without', 'with'] as const;
export type Stage2Condition = (typeof STAGE2_CONDITIONS)[number];

/**
 * The relational queries whose answer fact `vector` placed in its top ten in
 * P2-B's committed run: Recall@10 of 0.760 over 50. Fixed by the PRD before
 * any answer existed; the runner refuses a retrieval that selects another
 * number, because then it is not the run the rule was written against.
 */
export const STAGE2_QUERY_COUNT = 38;

/** One `generateContent` call per query per condition. */
export const STAGE2_CALLS = STAGE2_QUERY_COUNT * STAGE2_CONDITIONS.length;

// --- The graders ---------------------------------------------------------------------

/**
 * The concepts a relational pair's gold paths end at: B, the concept the
 * answer fact mentions and the question does not name.
 */
export function bridgeConcepts(pair: ExplanationPair): string[] {
  return [...new Set(pair.gold.map((path) => path.concepts[path.concepts.length - 1]!))];
}

/**
 * `bridge_named`, reported only: the answer names B by its label, compared in
 * the form `answer_key_present` uses. It says whether the paths changed what
 * the answer talks about, which the key alone cannot.
 */
export function bridgeNamed(answer: string, bridgeLabels: readonly string[]): boolean {
  const normalized = normalizeAnswerText(answer);
  return bridgeLabels.some((label) => normalized.includes(normalizeAnswerText(label)));
}

export interface Stage2Grades {
  /** The rule's grader: the answer contains one of the pre-registered alternatives. */
  readonly answerKeyPresent: boolean;
  /** Reported only. */
  readonly bridgeNamed: boolean;
}

export function gradeStage2Answer(
  answer: string,
  answerKey: readonly string[],
  bridgeLabels: readonly string[],
): Stage2Grades {
  return {
    answerKeyPresent: answerKeyPresent(answer, answerKey),
    bridgeNamed: bridgeNamed(answer, bridgeLabels),
  };
}

// --- The report ----------------------------------------------------------------------

/** One recorded answer, as the report needs it. */
export interface Stage2Answer {
  readonly content: string;
  readonly recordedAt: string;
  /** Which invocation of the recorder made the call, counting from 1. */
  readonly invocation: number;
}

export interface Stage2QueryInput {
  readonly queryId: string;
  readonly answerKey: readonly string[];
  readonly bridgeLabels: readonly string[];
  /** Retrieved facts the `with` block gave a line, out of the ten. */
  readonly explainedFacts: number;
  /** Whether the answer fact was among them. */
  readonly answerFactExplained: boolean;
  /** Absent for a condition not yet recorded. */
  readonly answers: Partial<Record<Stage2Condition, Stage2Answer>>;
}

export interface Stage2QueryResult {
  readonly queryId: string;
  readonly explainedFacts: number;
  readonly answerFactExplained: boolean;
  readonly grades: Partial<Record<Stage2Condition, Stage2Grades>>;
  /** The invocations that recorded `without` and `with`, when they differ. */
  readonly split: readonly number[] | null;
}

export interface GraderSummary {
  /** The rate in each condition over the queries recorded in it. */
  readonly without: number | null;
  readonly with: number | null;
  /** `with` − `without`, paired by query, once every answer is recorded. */
  readonly difference: PairedBootstrapResult | null;
}

export interface Stage2Report {
  readonly formatVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** `model` is `replay` when the answers came from the file and `live` when this run recorded any. */
  readonly axes: {
    readonly memory: 'live';
    readonly model: 'live' | 'replay';
    readonly embeddings: 'recorded';
  };
  readonly dataset: { readonly sha256: string; readonly labelsSha256: string };
  readonly answers: {
    readonly file: string;
    /** sha256 of the answer file's bytes when the report was written; null when there is none. */
    readonly sha256: string | null;
    readonly chatModel: string;
    readonly recorded: number;
    readonly expected: number;
    readonly invocations: number;
    /** Oldest and newest `recordedAt`. */
    readonly recordedFrom: string | null;
    readonly recordedTo: string | null;
    /** Requests this run made to the model host. Zero on replay. */
    readonly requestsThisRun: number;
  };
  readonly config: {
    readonly topK: number;
    readonly margin: number;
    readonly bootstrap: BootstrapOptions & { readonly confidence: 0.95 };
  };
  readonly queries: readonly Stage2QueryResult[];
  readonly graders: {
    readonly answerKeyPresent: GraderSummary;
    readonly bridgeNamed: GraderSummary;
  };
  /** Null until every answer is recorded: a part-recorded comparison is not the pre-registered one. */
  readonly outcome: Stage2Outcome | null;
  readonly reason: string;
}

export interface Stage2ReportInput {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly model: 'live' | 'replay';
  readonly datasetSha256: string;
  readonly labelsSha256: string;
  readonly answerFile: string;
  readonly answerFileSha256: string | null;
  readonly chatModel: string;
  readonly requestsThisRun: number;
  readonly topK: number;
  readonly bootstrap: BootstrapOptions;
  /** The selected queries, in the order the recorder asks them. */
  readonly queries: readonly Stage2QueryInput[];
}

const rate = (values: readonly boolean[]): number | null =>
  values.length === 0 ? null : values.filter(Boolean).length / values.length;

export function buildStage2Report(input: Stage2ReportInput): Stage2Report {
  const results: Stage2QueryResult[] = input.queries.map((q) => {
    const grades: Partial<Record<Stage2Condition, Stage2Grades>> = {};
    for (const condition of STAGE2_CONDITIONS) {
      const answer = q.answers[condition];
      if (answer !== undefined) {
        grades[condition] = gradeStage2Answer(answer.content, q.answerKey, q.bridgeLabels);
      }
    }
    const invocations = STAGE2_CONDITIONS.flatMap((c) => {
      const answer = q.answers[c];
      return answer === undefined ? [] : [answer.invocation];
    });
    return {
      queryId: q.queryId,
      explainedFacts: q.explainedFacts,
      answerFactExplained: q.answerFactExplained,
      grades,
      split: invocations.length === 2 && invocations[0] !== invocations[1] ? invocations : null,
    };
  });

  const all = input.queries.flatMap((q) =>
    STAGE2_CONDITIONS.flatMap((c) => (q.answers[c] === undefined ? [] : [q.answers[c]!])),
  );
  const expected = input.queries.length * STAGE2_CONDITIONS.length;
  const complete = input.queries.length > 0 && all.length === expected;
  const times = all.map((a) => a.recordedAt).sort();

  const summarize = (pick: (g: Stage2Grades) => boolean): GraderSummary => {
    const of = (c: Stage2Condition): boolean[] =>
      results.flatMap((r) => (r.grades[c] === undefined ? [] : [pick(r.grades[c]!)]));
    return {
      without: rate(of('without')),
      with: rate(of('with')),
      difference: complete
        ? pairedBootstrap(
            results.map((r) => (pick(r.grades.with!) ? 1 : 0)),
            results.map((r) => (pick(r.grades.without!) ? 1 : 0)),
            input.bootstrap,
          )
        : null,
    };
  };

  const answerKey = summarize((g) => g.answerKeyPresent);
  const outcome = answerKey.difference === null ? null : applyAnswerRule(answerKey.difference);

  return {
    formatVersion: 1,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    axes: { memory: 'live', model: input.model, embeddings: 'recorded' },
    dataset: { sha256: input.datasetSha256, labelsSha256: input.labelsSha256 },
    answers: {
      file: input.answerFile,
      sha256: input.answerFileSha256,
      chatModel: input.chatModel,
      recorded: all.length,
      expected,
      invocations: new Set(all.map((a) => a.invocation)).size,
      recordedFrom: times[0] ?? null,
      recordedTo: times[times.length - 1] ?? null,
      requestsThisRun: input.requestsThisRun,
    },
    config: {
      topK: input.topK,
      margin: STAGE2_MARGIN,
      bootstrap: { ...input.bootstrap, confidence: 0.95 },
    },
    queries: results,
    graders: { answerKeyPresent: answerKey, bridgeNamed: summarize((g) => g.bridgeNamed) },
    outcome,
    reason: complete
      ? `every answer is recorded; the rule reads answer_key_present, with − without`
      : `${all.length} of ${expected} answers are recorded; the rule is applied once all are`,
  };
}

/**
 * What the stage-1 report says about stage 2, given the stage-2 report.
 * `generateContentCalls` is what the recording spent, not what this run did,
 * which on replay is nothing.
 */
export interface Stage2Status {
  readonly ran: boolean;
  readonly generateContentCalls: number;
  readonly reason: string;
  readonly outcome: Stage2Outcome | null;
}

export function stage2Status(report: Stage2Report): Stage2Status {
  const { recorded, expected } = report.answers;
  if (report.outcome === null) {
    return {
      ran: false,
      generateContentCalls: recorded,
      reason: `stage 2 is part-recorded, ${recorded} of ${expected} answers; the rule is applied once all are`,
      outcome: null,
    };
  }
  return {
    ran: true,
    generateContentCalls: recorded,
    reason: `stage 2 is recorded in full and scored from the answer file (stage2-summary.md)`,
    outcome: report.outcome,
  };
}

// --- Rendering -------------------------------------------------------------------------

export function renderStage2Json(report: Stage2Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const f3 = (x: number | null): string => (x === null ? '—' : x.toFixed(3));
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
const yes = (g: Stage2Grades | undefined, pick: (g: Stage2Grades) => boolean): string =>
  g === undefined ? '—' : pick(g) ? 'yes' : 'no';
const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;
const header = (cells: readonly string[]): string =>
  `${row(cells)}\n${row(cells.map((c, i) => (i === 0 ? '---' : '---:')))}`;

export function renderStage2Markdown(report: Stage2Report): string {
  const a = report.answers;
  const out: string[] = [];
  out.push('# Graph explanation, stage 2: answers with and without the paths');
  out.push('');
  out.push(
    `- **Axes:** memory \`${report.axes.memory}\`, model \`${report.axes.model}\`, embeddings \`${report.axes.embeddings}\``,
  );
  out.push(`- **Dataset sha256:** \`${report.dataset.sha256}\``);
  out.push(`- **Labels sha256:** \`${report.dataset.labelsSha256}\``);
  out.push(
    `- **Answers:** ${a.recorded} of ${a.expected} recorded in \`${a.file}\`` +
      (a.sha256 === null ? '' : ` (sha256 \`${a.sha256}\`)`) +
      `, on \`${a.chatModel}\`, over ${a.invocations} invocation(s)` +
      (a.recordedFrom === null ? '' : `, ${a.recordedFrom} to ${a.recordedTo}`),
  );
  out.push(`- **Requests to the model host in this run:** ${a.requestsThisRun}`);
  out.push(
    `- **Configuration:** vector retrieval at topK ${report.config.topK}, ` +
      `bootstrap ${report.config.bootstrap.resamples} resamples seed ${report.config.bootstrap.seed}, 95% percentile`,
  );
  out.push(`- **Run:** ${report.startedAt} to ${report.finishedAt}`);
  out.push('');

  out.push('## Graders');
  out.push('');
  out.push(header(['Grader', 'without', 'with', 'with − without', '95% interval', 'sd', 'n']));
  for (const [name, g] of [
    ['`answer_key_present` (rule)', report.graders.answerKeyPresent],
    ['`bridge_named` (reported)', report.graders.bridgeNamed],
  ] as const) {
    const d = g.difference;
    out.push(
      row([
        name,
        f3(g.without),
        f3(g.with),
        d === null ? '—' : signed(d.mean),
        d === null ? '—' : `[${signed(d.lower)}, ${signed(d.upper)}]`,
        d === null ? '—' : f3(d.sd),
        d === null ? '—' : d.n,
      ]),
    );
  }
  out.push('');

  out.push('## Decision rule');
  out.push('');
  out.push(
    `Pre-registered in P2-D: \`met\` if \`answer_key_present\` improves by at least +${report.config.margin.toFixed(2)} ` +
      `with the paths and the bootstrap's lower bound is above 0; otherwise \`not met\`. ${report.reason}.`,
  );
  out.push('');
  out.push(
    report.outcome === null ? '**Stage 2: not decided.**' : `**Stage 2: ${report.outcome}.**`,
  );
  out.push('');

  out.push('## Per query');
  out.push('');
  out.push(
    header([
      'Query',
      'Facts explained',
      'Answer fact explained',
      'Key without',
      'Key with',
      'Bridge without',
      'Bridge with',
      'Split across invocations',
    ]),
  );
  const key = (g: Stage2Grades): boolean => g.answerKeyPresent;
  const bridge = (g: Stage2Grades): boolean => g.bridgeNamed;
  for (const q of report.queries) {
    out.push(
      row([
        `\`${q.queryId}\``,
        q.explainedFacts,
        q.answerFactExplained ? 'yes' : 'no',
        yes(q.grades.without, key),
        yes(q.grades.with, key),
        yes(q.grades.without, bridge),
        yes(q.grades.with, bridge),
        q.split === null ? '—' : q.split.join(', '),
      ]),
    );
  }
  return `${out.join('\n')}\n`;
}
