import { MemorySaver, getConfig, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  CassetteMissError,
  DecisionQueue,
  canonicalJson,
  diffLines,
  type Deck,
  type DecisionCall,
} from '@repo/agent-cassette';
import type {
  RecordSeam,
  RunDecision,
  RunRecord,
  RunRecordRepository,
  StoredRun,
} from '@repo/memory-core';
import { PolicyCatalogue, loadPayer } from '@repo/prior-auth';
import { buildAgentGraph } from '../agent/graph/graph.js';
import { buildPriorAuthGraph } from '../agent/prior-auth/graph.js';
import { replayModelDeps, replayRetrievalFacade } from '../agent/model/decision-seam.js';
import { CapturedWrites, type CapturedWrite } from './captured-writes.js';

/**
 * `audit:replay` (P3-B, ADR 0007): re-execute a recorded run with every input
 * served from its record, and compare every super-step with the checkpoint
 * history the run left.
 *
 * A run is a function of the code at a commit, the request, the answers at the
 * decision seam and the retrieval reads; the checkpoint history is its trace.
 * So the record holds the arguments, and replay re-evaluates the function and
 * checks the trace. A match proves the record **complete** — no unrecorded
 * input moved any state transition — and **consistent** with the checkpoints.
 * It does not prove either is unaltered: an edit made consistently to both
 * passes, and catching that is P3-C's ledger.
 *
 * Nothing here constructs a store client or a model client. The record and the
 * history are read through whatever the caller passes, which for the command
 * is a read-only pool; the model half is `replayModelDeps`, which takes no
 * live set; retrieval is served from the record; and `reflect`'s writers
 * capture. A node that read an input nobody recorded would fail loudly here
 * rather than silently read today's data.
 */

/** 0 every step matched; 1 the replay diverged; 2 the record could not be replayed here. */
export type ReplayExitCode = 0 | 1 | 2;

/** One super-step: the recorded checkpoint, and how the replayed one compared. */
export interface ReplayStep {
  /** `metadata.step` of the recorded checkpoint, -1 for the input. */
  readonly step: number;
  /** The node whose writes produced this checkpoint. */
  readonly node: string;
  /** The nodes the checkpoint says run next. */
  readonly next: readonly string[];
  /** Channels whose value differs from the previous checkpoint's. */
  readonly changed: readonly string[];
  /** The seams served to the node that produced this checkpoint, in order. */
  readonly decisions: readonly string[];
  /** `null` under `--read-only`, which compares nothing. */
  readonly match: boolean | null;
}

export interface ReplayReport {
  readonly runId: string;
  readonly exitCode: ReplayExitCode;
  readonly verdict: 'match' | 'diverged' | 'refused' | 'reconstructed';
  /** Why, for anything but a match. */
  readonly reason?: string;
  readonly record?: Omit<RunRecord, 'request'>;
  readonly buildSha: string | null;
  readonly request?: unknown;
  readonly steps: readonly ReplayStep[];
  readonly recordedCheckpoints: number;
  readonly replayedCheckpoints: number;
  readonly decisions: {
    readonly recorded: number;
    readonly consumed: number;
    readonly unconsumed: readonly { readonly seam: string; readonly label?: string }[];
  };
  /** The first step whose checkpoint differs, with the channels that differ. */
  readonly divergence?: {
    readonly step: number;
    readonly node: string;
    readonly channels: readonly string[];
    readonly diff: string;
  };
  /** What the replayed run threw, if it threw. */
  readonly replayError?: string;
  /** What `reflect` asked to write. Derived, never read from the stores. */
  readonly writes: readonly CapturedWrite[];
}

export interface ReplayOptions {
  readonly runId: string;
  /** Read-only access to the run record. */
  readonly records: RunRecordRepository;
  /** Read-only access to the recorded checkpoint history. */
  readonly checkpointer: BaseCheckpointSaver;
  /** The running build's commit; replay refuses any other. */
  readonly buildSha: string | null;
  /** Print the reconstruction without re-executing. */
  readonly readOnly?: boolean;
}

interface Snapshot {
  readonly step: number;
  readonly next: readonly string[];
  readonly values: Record<string, unknown>;
}

/** A compiled graph of either kind, as replay uses it. */
interface ReplayableGraph {
  invoke(input: unknown, config: unknown): Promise<unknown>;
  getStateHistory(config: unknown): AsyncIterable<{
    values: unknown;
    next: readonly string[];
    metadata?: { step?: number } | undefined;
  }>;
}

export async function replayRun(options: ReplayOptions): Promise<ReplayReport> {
  const stored = await options.records.read(options.runId);
  const empty = {
    runId: options.runId,
    buildSha: options.buildSha,
    steps: [],
    recordedCheckpoints: 0,
    replayedCheckpoints: 0,
    decisions: { recorded: 0, consumed: 0, unconsumed: [] },
    writes: [],
  };

  if (stored === null) {
    return refuse(empty, `there is no run record for ${options.runId}`);
  }

  const { request, ...header } = stored.record;
  const described = { ...empty, record: header, request };
  const refusal = shaRefusal(stored.record.gitSha, options.buildSha);
  if (refusal !== undefined) return refuse(described, refusal);

  const thread = { configurable: { thread_id: options.runId } };
  const recordedGraph = compile(
    stored,
    unreachableDeck(),
    new CapturedWrites(),
    options.checkpointer,
  );
  const recorded = await history(recordedGraph, thread);
  const decisions = stored.decisions.map((row) => row.decision);

  if (options.readOnly === true) {
    return {
      ...described,
      exitCode: 0,
      verdict: 'reconstructed',
      steps: describeSteps(recorded, attributeBySeam(recorded, decisions), () => null),
      recordedCheckpoints: recorded.length,
      decisions: { recorded: decisions.length, consumed: 0, unconsumed: [] },
    };
  }

  // Every decision the run made, served in recorded order, one queue per
  // request. Each is noted against the super-step that asked for it, which
  // LangGraph names in the running task's config: the checkpoint that step
  // writes carries the same number. Observing the stream instead would not
  // do, because the graph runs ahead of whoever is reading it.
  const queue = new DecisionQueue<RecordSeam>(decisions);
  const servedAtStep = new Map<number, string[]>();
  const tracking: Deck<RecordSeam> = {
    mode: 'replay',
    resolve: <R>(call: DecisionCall<RecordSeam>, live: () => Promise<R>): Promise<R> => {
      const step = Number(getConfig()?.metadata?.['langgraph_step'] ?? Number.NaN);
      servedAtStep.set(step, [...(servedAtStep.get(step) ?? []), call.seam]);
      return queue.resolve(call, live);
    },
  };

  const writes = new CapturedWrites();
  const replayGraph = compile(stored, tracking, writes, new MemorySaver());
  let replayError: unknown;

  try {
    await replayGraph.invoke(input(stored), thread);
  } catch (error) {
    replayError = error;
  }

  const replayed = await history(replayGraph, thread);
  const comparison = compare(recorded, replayed);
  const unconsumed = queue.unconsumed().map(({ seam, label }) => ({
    seam,
    ...(label === undefined ? {} : { label }),
  }));
  const perStep = (index: number): readonly string[] =>
    servedAtStep.get(recorded[index]?.step ?? Number.NaN) ?? [];

  const report = {
    ...described,
    steps: describeSteps(recorded, perStep, (index) => comparison.matches[index] ?? false),
    recordedCheckpoints: recorded.length,
    replayedCheckpoints: replayed.length,
    decisions: {
      recorded: decisions.length,
      consumed: decisions.length - unconsumed.length,
      unconsumed,
    },
    ...(comparison.divergence === undefined ? {} : { divergence: comparison.divergence }),
    ...(replayError === undefined ? {} : { replayError: message(replayError) }),
    writes: writes.writes,
  };

  const failed = verdictOf(stored, comparison, unconsumed.length, replayError);
  return failed === undefined
    ? { ...report, exitCode: 0, verdict: 'match' }
    : { ...report, exitCode: 1, verdict: 'diverged', reason: failed };
}

/**
 * Replay runs at the recorded commit or not at all. The LangGraph that reads
 * the history is then the one that wrote it, so no cross-version checkpoint
 * question arises, and the prompts, the tool registry and `CHAT_MODEL` are the
 * ones the run had — all of which the record names only through the sha.
 */
function shaRefusal(recorded: string | null, build: string | null): string | undefined {
  if (recorded === null) {
    return (
      'the record names no commit (git_sha is null): the run was served by a build with no ' +
      'GIT_SHA and no .git, so nothing says which code to replay it with'
    );
  }
  if (build === null) {
    return (
      `the record was made at ${recorded}, and this build names no commit: run the command ` +
      'in the image built with GIT_SHA set, or from a checkout'
    );
  }
  if (recorded !== build) {
    return (
      `the record was made at ${recorded}, and this build is ${build}: replay runs only at ` +
      `the recorded commit — run it in the image tagged ${recorded}`
    );
  }
  return undefined;
}

function verdictOf(
  stored: StoredRun,
  comparison: Comparison,
  unconsumed: number,
  replayError: unknown,
): string | undefined {
  if (replayError instanceof CassetteMissError) {
    return `the replay asked for a decision the record does not hold:\n${replayError.message}`;
  }
  if (comparison.divergence !== undefined) {
    const { step, node } = comparison.divergence;
    return `the replayed checkpoint at step ${step} (${node}) differs from the recorded one`;
  }
  if (comparison.countsDiffer) {
    return 'the replay left a different number of checkpoints from the recorded run';
  }
  if (unconsumed > 0) {
    return (
      `${unconsumed} recorded decision(s) were never asked for: the replayed run made fewer ` +
      'calls than the recorded one, so it is not the run that was recorded'
    );
  }
  const failedThen = stored.record.outcome === 'error';
  const failedNow = replayError !== undefined;
  if (failedThen !== failedNow) {
    return failedNow
      ? `the replay failed where the recorded run did not: ${message(replayError)}`
      : 'the recorded run failed and the replay did not';
  }
  return undefined;
}

function refuse(report: Omit<ReplayReport, 'exitCode' | 'verdict'>, reason: string): ReplayReport {
  return { ...report, exitCode: 2, verdict: 'refused', reason };
}

/** The graph the record is of, built from the record's own inputs. */
function compile(
  stored: StoredRun,
  deck: Deck<RecordSeam>,
  writes: CapturedWrites,
  checkpointer: BaseCheckpointSaver,
): ReplayableGraph {
  const model = replayModelDeps(deck);
  const record = stored.record;

  if (record.graph === 'prior-auth') {
    // The clock is the record's: `receivedAt` is its start time, and `dispose`
    // reads the clock only for a span attribute.
    const clock = { now: () => record.startedAt };
    return buildPriorAuthGraph(
      { payer: loadPayer(), catalogue: PolicyCatalogue.load(), assess: model.assess, clock },
      checkpointer,
    ) as unknown as ReplayableGraph;
  }

  return buildAgentGraph(
    {
      retrieve: { retrievalFacade: replayRetrievalFacade(deck), embedQuery: model.embed },
      plan: model.plan,
      act: model.act,
      distill: model.distill,
      reflect: {
        episodicRepo: writes.episodicRepo,
        neo4jWriter: writes.neo4jWriter,
        pgvectorWriter: writes.pgvectorWriter,
        embedText: model.embed,
      },
    },
    record.request,
    record.correlationId,
    checkpointer,
  ) as unknown as ReplayableGraph;
}

/** What the service invoked the graph with: the run id, and for prior-auth the receipt. */
function input(stored: StoredRun): Record<string, unknown> {
  const record = stored.record;
  if (record.graph === 'prior-auth') {
    return {
      caseId: record.runId,
      bundle: record.request,
      receivedAt: record.startedAt.toISOString(),
      findings: [],
    };
  }
  return { runId: record.runId };
}

/** A deck for reading history only: compiling a graph needs one, and nothing calls it. */
function unreachableDeck(): Deck<RecordSeam> {
  return {
    mode: 'replay',
    resolve: () => Promise.reject(new Error('reading a checkpoint history ran a node')),
  };
}

async function history(graph: ReplayableGraph, thread: unknown): Promise<Snapshot[]> {
  const snapshots: Snapshot[] = [];
  for await (const snapshot of graph.getStateHistory(thread)) {
    snapshots.push({
      step: snapshot.metadata?.step ?? Number.NaN,
      next: [...snapshot.next],
      values: (snapshot.values ?? {}) as Record<string, unknown>,
    });
  }
  // Newest first from the saver; the run's order is the other way.
  return snapshots.reverse();
}

interface Comparison {
  readonly matches: readonly boolean[];
  readonly countsDiffer: boolean;
  readonly divergence?: NonNullable<ReplayReport['divergence']>;
}

/**
 * Checkpoint by checkpoint: `next`, and the canonical JSON of every channel.
 * Checkpoint ids, timestamps and metadata are excluded — they are the saver's,
 * not the run's.
 */
function compare(recorded: readonly Snapshot[], replayed: readonly Snapshot[]): Comparison {
  const matches: boolean[] = [];
  let divergence: Comparison['divergence'];

  for (let index = 0; index < recorded.length; index += 1) {
    const want = recorded[index]!;
    const got = replayed[index];
    const channels =
      got === undefined ? ['(no replayed checkpoint)'] : differingChannels(want, got);
    const same = channels.length === 0;
    matches.push(same);

    if (!same && divergence === undefined) {
      divergence = {
        step: want.step,
        node: nodeAt(recorded, index),
        channels,
        diff: got === undefined ? '' : channelDiff(want, got, channels),
      };
    }
  }

  return {
    matches,
    countsDiffer: recorded.length !== replayed.length,
    ...(divergence === undefined ? {} : { divergence }),
  };
}

function differingChannels(want: Snapshot, got: Snapshot): string[] {
  const channels = new Set([...Object.keys(want.values), ...Object.keys(got.values)]);
  const differing = [...channels]
    .filter((channel) => canonicalJson(want.values[channel]) !== canonicalJson(got.values[channel]))
    .sort();
  if (canonicalJson(want.next) !== canonicalJson(got.next)) differing.unshift('(next)');
  return differing;
}

function channelDiff(want: Snapshot, got: Snapshot, channels: readonly string[]): string {
  return channels
    .map((channel) => {
      const pick = (snapshot: Snapshot): unknown =>
        channel === '(next)' ? snapshot.next : snapshot.values[channel];
      return `${channel}:\n${diffLines(pretty(pick(want)), pretty(pick(got)))}`;
    })
    .join('\n');
}

function pretty(value: unknown): string {
  return value === undefined
    ? '(absent)'
    : JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
}

/** The node whose writes produced checkpoint `index`: the one the previous checkpoint named next. */
function nodeAt(snapshots: readonly Snapshot[], index: number): string {
  if (index === 0) return '(input)';
  return snapshots[index - 1]?.next.join(', ') || '(none)';
}

function describeSteps(
  recorded: readonly Snapshot[],
  decisionsAt: (index: number) => readonly string[],
  matchAt: (index: number) => boolean | null,
): ReplayStep[] {
  return recorded.map((snapshot, index) => {
    const previous = recorded[index - 1];
    const changed =
      previous === undefined
        ? Object.keys(snapshot.values).sort()
        : Object.keys({ ...previous.values, ...snapshot.values })
            .filter(
              (channel) =>
                canonicalJson(previous.values[channel]) !== canonicalJson(snapshot.values[channel]),
            )
            .sort();
    return {
      step: snapshot.step,
      node: nodeAt(recorded, index),
      next: snapshot.next,
      changed,
      decisions: decisionsAt(index),
      match: matchAt(index),
    };
  });
}

/**
 * Which node asked for each decision, without running anything: by the seams
 * each node owns, in order. Exact for these two graphs, which have one path
 * through every super-step and give each seam to one node — except `embed`,
 * which `retrieve` asks once before its read and `reflect` asks once per fact.
 * A full replay attributes by observation instead.
 */
function attributeBySeam(
  recorded: readonly Snapshot[],
  decisions: readonly RunDecision[],
): (index: number) => readonly string[] {
  const owned: Record<string, { seams: readonly string[]; endsAt?: string }> = {
    retrieve: { seams: ['embed', 'memory.retrieve'], endsAt: 'memory.retrieve' },
    plan: { seams: ['plan.callLlm'], endsAt: 'plan.callLlm' },
    act: { seams: ['act.selectTool', 'act.tool'] },
    distill: { seams: ['distill.extractEntities'], endsAt: 'distill.extractEntities' },
    reflect: { seams: ['embed'] },
    assess: { seams: ['assess.criteria'], endsAt: 'assess.criteria' },
  };

  let cursor = 0;
  const byIndex = recorded.map((_, index) => {
    const node = owned[nodeAt(recorded, index)];
    const taken: string[] = [];
    if (node === undefined) return taken;

    let selected = false;
    while (cursor < decisions.length) {
      const decision = decisions[cursor]!;
      if (!node.seams.includes(decision.seam)) break;
      // One selection per `act` step, then the tool calls it made.
      if (decision.seam === 'act.selectTool' && selected) break;
      taken.push(decision.seam);
      cursor += 1;
      const succeeded = decision.response.kind !== 'error';
      if (decision.seam === 'act.selectTool' && succeeded) selected = true;
      if (node.endsAt === decision.seam && succeeded) break;
    }
    return taken;
  });

  return (index) => byIndex[index] ?? [];
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
