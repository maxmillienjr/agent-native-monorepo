import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CassetteSchema,
  decodeFloat32Base64,
  VECTOR_SEAM,
  type Cassette,
  type Decision,
} from '@repo/agent-cassette';
import { cassettePath } from '@repo/eval-harness';
import { cosine } from './probes.js';

/**
 * The nightly's decisions against the committed cassettes (P1-E, handed over
 * by P1-C).
 *
 * The live job records a cassette per trial anyway, so this costs no model
 * call. It is descriptive: a chat model sampled at the default temperature is
 * not expected to reproduce its text, so text that differs is not reported as
 * drift. What it can say exactly is whether an embedding both runs asked for
 * came back identical — the user's message is the same every night, so each
 * trial's first `embed` is always shared — and where the two runs first asked
 * for something different.
 */
export interface DecisionComparison {
  readonly taskId: string;
  readonly trialIndex: number;
  /** `embed` decisions whose requestHash is in both sets, and how many are bit-identical. */
  readonly sharedEmbeds: {
    readonly count: number;
    readonly identical: number;
    /** `null` when nothing was shared, rather than a cosine nobody measured. */
    readonly minCosine: number | null;
  };
  /** The first live decision whose requestHash the committed trial lacks, by seam and position. */
  readonly firstDivergence: { readonly seam: string; readonly index: number } | null;
  /** Tool names chosen by `act.selectTool`, in order, on each side. */
  readonly tools: {
    readonly committed: readonly (string | null)[];
    readonly live: readonly (string | null)[];
  };
}

function vectorOf(decision: Decision): string | undefined {
  return decision.response.kind === 'vector' ? decision.response.float32Base64 : undefined;
}

/** What `selectTool` returned: a tool name, or `null` for no tool or a recorded error. */
function toolChosen(decision: Decision): string | null {
  if (decision.response.kind !== 'value') return null;
  const name = (decision.response.value as { toolName?: unknown } | null)?.toolName;
  return typeof name === 'string' ? name : null;
}

export function compareCassettes(committed: Cassette, live: Cassette): DecisionComparison {
  const committedHashes = new Set(committed.decisions.map((decision) => decision.requestHash));
  const committedVectors = new Map<string, string>();
  for (const decision of committed.decisions) {
    const vector = vectorOf(decision);
    if (decision.seam === VECTOR_SEAM && vector !== undefined) {
      committedVectors.set(decision.requestHash, vector);
    }
  }

  let count = 0;
  let identical = 0;
  let minCosine: number | null = null;
  for (const decision of live.decisions) {
    if (decision.seam !== VECTOR_SEAM) continue;
    const ours = vectorOf(decision);
    const theirs = committedVectors.get(decision.requestHash);
    if (ours === undefined || theirs === undefined) continue;
    count += 1;
    const similarity =
      ours === theirs ? 1 : cosine(decodeFloat32Base64(theirs), decodeFloat32Base64(ours));
    if (ours === theirs) identical += 1;
    minCosine = minCosine === null ? similarity : Math.min(minCosine, similarity);
  }

  const divergent = live.decisions.findIndex(
    (decision) => !committedHashes.has(decision.requestHash),
  );
  const tools = (cassette: Cassette): (string | null)[] =>
    cassette.decisions
      .filter((decision) => decision.seam === 'act.selectTool')
      .map((decision) => toolChosen(decision));

  return {
    taskId: live.header.taskId,
    trialIndex: live.header.trialIndex,
    sharedEmbeds: { count, identical, minCosine },
    firstDivergence:
      divergent === -1 ? null : { seam: live.decisions[divergent]!.seam, index: divergent },
    tools: { committed: tools(committed), live: tools(live) },
  };
}

const list = (tools: readonly (string | null)[]): string =>
  tools.length === 0 ? '—' : tools.map((tool) => (tool === null ? 'none' : tool)).join(' → ');

/** The job-summary Markdown for a night's comparisons. */
export function renderComparisonSummary(
  comparisons: readonly DecisionComparison[],
  options: { readonly chatModels: readonly string[]; readonly missing: readonly string[] },
): string {
  const lines: string[] = [
    '## Decisions — nightly live run against the committed cassettes',
    '',
    `**Live chat model:** ${options.chatModels.map((id) => `\`${id}\``).join(', ') || '—'}. ` +
      'Descriptive, not a gate: a sampled chat model is not expected to reproduce its text, ' +
      'so a divergence is not drift. Shared embeddings are exact, and a differing one is.',
    '',
    '| Task | Trial | Shared embeds identical | Min cosine | First divergence | Tools, committed | Tools, live |',
    '| ---- | ----- | ----------------------- | ---------- | ---------------- | ---------------- | ----------- |',
    ...comparisons.map(
      (comparison) =>
        `| \`${comparison.taskId}\` | ${comparison.trialIndex} | ` +
        `${comparison.sharedEmbeds.identical}/${comparison.sharedEmbeds.count} | ` +
        `${comparison.sharedEmbeds.minCosine === null ? '—' : comparison.sharedEmbeds.minCosine.toFixed(9)} | ` +
        `${comparison.firstDivergence === null ? 'none' : `\`${comparison.firstDivergence.seam}\` #${comparison.firstDivergence.index}`} | ` +
        `${list(comparison.tools.committed)} | ${list(comparison.tools.live)} |`,
    ),
  ];

  const differing = comparisons.filter(
    (comparison) => comparison.sharedEmbeds.identical < comparison.sharedEmbeds.count,
  );
  if (differing.length > 0) {
    lines.push(
      '',
      `> **A shared embedding differs** in ${differing.length} trial(s). The embedding model ` +
        'returned a different vector for a text the committed set recorded; see the canary job.',
    );
  }
  if (options.missing.length > 0) {
    lines.push(
      '',
      `> **No committed cassette to compare with:** ${options.missing.map((name) => `\`${name}\``).join(', ')}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Every live cassette in a directory against the committed set.
 *
 * A live trial is compared with the committed trial of the same index, or with
 * trial 0 when the committed set has fewer — it has one trial per task, and a
 * dispatch can run more.
 */
export function compareDirectories(
  liveDir: string,
  datasetDir: string,
): {
  comparisons: DecisionComparison[];
  chatModels: string[];
  missing: string[];
} {
  const read = (path: string): Cassette =>
    CassetteSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const comparisons: DecisionComparison[] = [];
  const chatModels = new Set<string>();
  const missing: string[] = [];

  const files = existsSync(liveDir)
    ? readdirSync(liveDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  for (const name of files) {
    const live = read(join(liveDir, name));
    chatModels.add(live.header.chatModel);
    const candidates = [
      cassettePath(datasetDir, live.header.taskId, live.header.trialIndex),
      cassettePath(datasetDir, live.header.taskId, 0),
    ];
    const committed = candidates.find((path) => existsSync(path));
    if (committed === undefined) {
      missing.push(name);
      continue;
    }
    comparisons.push(compareCassettes(read(committed), live));
  }

  return { comparisons, chatModels: [...chatModels].sort(), missing };
}
