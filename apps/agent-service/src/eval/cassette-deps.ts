import { execFileSync } from 'node:child_process';
import { subscribe } from 'node:diagnostics_channel';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@repo/memory-core';
import { cassettePath, type Axes, type ModelIds, type ReplayProvenance } from '@repo/eval-harness';
import {
  CASSETTE_FORMAT_VERSION,
  CassetteIncompatibleError,
  CassettePlayer,
  CassetteRecorder,
  type Deck,
  type Decision,
  type DecisionCall,
  type ReplayConfig,
  type TokenCounts,
} from '@repo/agent-cassette';
import {
  activeInferenceSpan,
  withInferenceSpan,
  type InferenceRequest,
  type InferenceSeam,
} from '@repo/telemetry';
import type { EvidenceItem, PolicyCriterion } from '@repo/prior-auth';
import { CHAT_MODEL, type ModelDeps } from '../runs/runs.service.js';
import type { CaseBoard } from '../agent/tools/case-board.js';
import { defaultRegistry, defineRegistry, type ToolRegistry } from '../agent/tools/registry.js';
import type { ToolSelectionRequest } from '../agent/tools/selection.js';
import type { CompensableTool, ToolDefinition } from '../agent/tools/types.js';
import { RE_RECORD_COMMAND, UPDATE_BASELINE_COMMAND } from './abort-cause.js';

/**
 * `ModelDeps` ⟷ `Deck`, in both directions.
 *
 * This is the only file that knows both what a cassette is and what the service
 * is. `packages/agent-cassette` depends on `zod` and nothing else in this
 * repository; `RunsService` takes a `(ModelDeps) => ModelDeps` and never learns
 * that a cassette exists. The translation between them lives here because it is
 * the one place that can hold both without either of them growing a dependency
 * on the other.
 */

/**
 * The requests, spelled once.
 *
 * A recorded request and a replayed one are hashed by the same function over
 * the same object, so the two directions cannot be allowed to describe the same
 * call differently — a field that exists on one side and not the other is a
 * miss on every trial, and the error it produces points at the prompt rather
 * than at the two spellings that actually disagree.
 *
 * Nothing here carries the `runId`. That is what lets a replayed run mint a
 * fresh one, write under it, and still be graded by `episodic_row_written` and
 * `entity_merged`, which read persisted state for *this* run. `hash-stability`
 * in the unit tests is the assertion that keeps it true.
 */
const calls = {
  plan: (systemPrompt: string, userPrompt: string): DecisionCall => ({
    seam: 'plan.callLlm',
    request: { systemPrompt, userPrompt },
  }),
  // The whole request: the plan, every tool's description, tier and schema,
  // and the run's previous calls. A tool added to the registry, a description
  // reworded or an output that changed all move this hash, which is the point.
  selectTool: (request: ToolSelectionRequest): DecisionCall => ({
    seam: 'act.selectTool',
    request,
  }),
  tool: (name: string, input: unknown): DecisionCall => ({
    seam: 'act.tool',
    label: name,
    request: input,
  }),
  // The step's input and output, which is what an undo is a function of. The
  // idempotency key is left out: it carries the run id, and a replayed run
  // mints a new one.
  compensate: (name: string, input: unknown, output: unknown): DecisionCall => ({
    seam: 'act.compensate',
    label: name,
    request: { input, output },
  }),
  extract: (context: string): DecisionCall => ({
    seam: 'distill.extractEntities',
    request: { context },
  }),
  embed: (text: string): DecisionCall => ({ seam: 'embed', request: { text } }),
  assess: (
    criteria: readonly PolicyCriterion[],
    evidence: readonly EvidenceItem[],
  ): DecisionCall => ({
    seam: 'assess.criteria',
    request: { criteria: [...criteria], evidence: [...evidence] },
  }),
} as const;

/** The three seams that are a `generateContent` call, and so carry usage. */
const CHAT_SEAMS: ReadonlySet<DecisionCall['seam']> = new Set([
  'plan.callLlm',
  'act.selectTool',
  'distill.extractEntities',
]);

/**
 * The usage a chat seam returned beside its answer.
 *
 * Every chat seam returns `{ ..., tokenCounts }` from format 2 on (P1-F), so
 * the recorder reads it at all three. `embed` and `act.tool` report none, and
 * none is claimed for them.
 */
export function tokenCountsFor(call: DecisionCall, response: unknown): TokenCounts | undefined {
  if (!CHAT_SEAMS.has(call.seam)) return undefined;
  return (response as { tokenCounts?: TokenCounts } | null | undefined)?.tokenCounts;
}

/** Recording: the live set, with every decision it makes appended to the deck. */
export function recordingModelDeps(live: ModelDeps, deck: Deck): ModelDeps {
  return {
    plan: {
      callLlm: (systemPrompt, userPrompt) =>
        deck.resolve(calls.plan(systemPrompt, userPrompt), () =>
          live.plan.callLlm(systemPrompt, userPrompt),
        ),
    },
    act: {
      registry: throughDeck(live.act.registry, {
        execute: (tool) => (input, ctx) =>
          deck.resolve(calls.tool(tool.name, input), () => tool.execute(input, ctx)),
        compensate: (tool) => (input, output, ctx) =>
          deck.resolve(calls.compensate(tool.name, input, output), () =>
            tool.compensate(input, output, ctx),
          ),
      }),
      selectTool: (request) =>
        deck.resolve(calls.selectTool(request), () => live.act.selectTool(request)),
    },
    distill: {
      extractEntities: (context) =>
        deck.resolve(calls.extract(context), () => live.distill.extractEntities(context)),
    },
    embed: (text) => deck.resolve(calls.embed(text), () => live.embed(text)),
    assess: {
      assessCriteria: (criteria, evidence) =>
        deck.resolve(calls.assess(criteria, evidence), () =>
          live.assess.assessCriteria(criteria, evidence),
        ),
    },
  };
}

/**
 * Replay: a `ModelDeps` built entirely from the deck.
 *
 * The live set is not an argument. A decorator that took one and ignored it
 * would still have caused it to be constructed, and the claim worth making is
 * that a replayed run has no model client in the process at all — which is
 * checkable by reading this signature rather than by trusting the player.
 *
 * The tool registry comes from `defaultRegistry` because the recorded
 * `act.selectTool` request carries every tool's description, tier and schema.
 * Rebuilding the list from the cassette's own `act.tool` entries would give a
 * run that selected no tool an empty registry, and the recorded request would
 * then miss on its own hash. The board it is built over throws: the tool seams
 * are served from the deck, so a replay that reached a board would be running
 * an effect the recording already ran.
 */
export function replayModelDeps(deck: Deck): ModelDeps {
  const unreachable = (): Promise<never> => {
    throw new Error(
      'a replayed dependency set tried to make a live call, which should be unreachable: ' +
        'the player never calls the thunk and no model client was constructed',
    );
  };

  // The span a live call would have had, so a transcript's spans do not depend
  // on the axis. The models are the running configuration's, which the player
  // has already checked equal to the cassette header's. What the recording
  // measured arrives through `onServe`; see `recordServedDecision`.
  const chat = (seam: Exclude<InferenceSeam, 'embed'>, json: boolean): InferenceRequest => ({
    operation: 'generate_content',
    model: CHAT_MODEL,
    seam,
    ...(json ? { outputType: 'json' as const } : {}),
  });
  const embedding: InferenceRequest = {
    operation: 'embeddings',
    model: EMBEDDING_MODEL,
    seam: 'embed',
    dimensions: EMBEDDING_DIMENSIONS,
  };

  return {
    plan: {
      callLlm: (systemPrompt, userPrompt) =>
        withInferenceSpan(chat('plan.callLlm', false), () =>
          deck.resolve(calls.plan(systemPrompt, userPrompt), unreachable),
        ),
    },
    act: {
      registry: throughDeck(defaultRegistry(UNREACHABLE_BOARD), {
        execute: (tool) => (input) => deck.resolve(calls.tool(tool.name, input), unreachable),
        compensate: (tool) => (input, output) =>
          deck.resolve(calls.compensate(tool.name, input, output), unreachable),
      }),
      selectTool: (request) =>
        withInferenceSpan(chat('act.selectTool', true), () =>
          deck.resolve(calls.selectTool(request), unreachable),
        ),
    },
    distill: {
      extractEntities: (context) =>
        withInferenceSpan(chat('distill.extractEntities', true), () =>
          deck.resolve(calls.extract(context), unreachable),
        ),
    },
    embed: (text) =>
      withInferenceSpan(embedding, () => deck.resolve(calls.embed(text), unreachable)),
    assess: {
      assessCriteria: (criteria, evidence) =>
        withInferenceSpan(chat('assess.criteria', true), () =>
          deck.resolve(calls.assess(criteria, evidence), unreachable),
        ),
    },
  };
}

/**
 * The registry with each tool's functions routed through the deck. Name,
 * description, tier and input stay the registry's own, so the selection
 * request a recording hashes is the one a request would send.
 */
function throughDeck(
  registry: ToolRegistry,
  route: {
    execute: (tool: ToolDefinition) => ToolDefinition['execute'];
    compensate: (tool: CompensableTool) => CompensableTool['compensate'];
  },
): ToolRegistry {
  return defineRegistry(
    registry.tools.map((tool): ToolDefinition =>
      tool.tier === 'compensable'
        ? { ...tool, execute: route.execute(tool), compensate: route.compensate(tool) }
        : { ...tool, execute: route.execute(tool) },
    ),
  );
}

/** The board a replayed registry is built over, which nothing may reach. */
const UNREACHABLE_BOARD: CaseBoard = {
  openRequest: () => {
    throw new Error('a replayed run reached the case board: act.tool must be served from the deck');
  },
  withdrawRequest: () => {
    throw new Error(
      'a replayed run reached the case board: act.compensate must be served from the deck',
    );
  },
  openRequests: () => [],
};

/**
 * What a replayed decision says about the span it is served inside.
 *
 * The player calls this from inside `resolve`, so the active span is the
 * inference or embeddings span `replayModelDeps` opened — or, at the
 * `act.tool` and `act.compensate` seams, the `execute_tool` span `act` or
 * `compensate` opened. Each is marked
 * `agent_native.replayed`, and a reader summing usage across tiers filters on
 * it: no call happened, and the span's duration is replay speed.
 *
 * The recorded usage is set where the cassette has it, and only there. Token
 * usage is a property of the request-and-response pair a cassette freezes, so
 * the recording measured it. From format 2 every chat decision carries it, with
 * `completion` as billed output — the same figure the live span derived — so a
 * replayed trial's `gen_ai.usage.*` sums are the recording's. A recorded error
 * carries none, and an absent count is not written as zero.
 */
export function recordServedDecision(decision: Decision): void {
  const span = activeInferenceSpan();
  if (span === undefined) return;
  span.markReplayed();
  if (decision.tokenCounts !== undefined) {
    span.recordUsage({
      input: decision.tokenCounts.prompt,
      output: decision.tokenCounts.completion,
      ...(decision.tokenCounts.reasoning === undefined
        ? {}
        : { reasoningOutput: decision.tokenCounts.reasoning }),
    });
  }
}

/**
 * One deck per trial.
 *
 * `AgentHarness.run(task)` is not given a trial index and the interface is not
 * this PRD's to change, so the index is tracked by the caller —
 * `AgentServiceHarness`, which sees `reset(task)` once before every trial.
 */
export interface TrialDecks {
  readonly mode: 'record' | 'replay';
  open(taskId: string, trialIndex: number): Deck;
  /**
   * Finishes the trial's deck. `completed` is false when the trial threw: a
   * cassette written from a crashed run replays a run that never happened.
   */
  close(completed: boolean): Promise<void>;
}

/** The commit a recording is made at, and whether the tree it was made from was clean. */
export function gitHead(): { sha: string; dirty: boolean } {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  return { sha, dirty: status !== '' };
}

/**
 * Recording decks, writing one cassette per trial.
 *
 * The axes arrive as data and go into the header, where `CassetteHeaderSchema`
 * pins both to the literal `live`. Recording the canned stub set would produce
 * a file that is schema-valid, replays cleanly and measures nothing, so the
 * refusal is the schema's rather than a check here that could be forgotten.
 */
export function recordingDecks(options: {
  datasetDir: string;
  axes: Axes;
  gitSha: string;
  now?: () => Date;
}): TrialDecks {
  const now = options.now ?? (() => new Date());
  let open: { recorder: CassetteRecorder; path: string } | undefined;

  return {
    mode: 'record',
    open(taskId, trialIndex) {
      const path = cassettePath(options.datasetDir, taskId, trialIndex);
      const recorder = new CassetteRecorder({
        header: {
          formatVersion: CASSETTE_FORMAT_VERSION,
          taskId,
          trialIndex,
          recordedAt: now().toISOString(),
          gitSha: options.gitSha,
          axes: { model: options.axes.model, memory: options.axes.memory },
          chatModel: CHAT_MODEL,
          embeddingModel: EMBEDDING_MODEL,
          embeddingDimensions: EMBEDDING_DIMENSIONS,
        },
        tokenCountsFor,
        sink: (cassette) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`);
        },
      });

      open = { recorder, path };
      return recorder;
    },
    async close(completed) {
      const current = open;
      open = undefined;
      if (current === undefined || !completed) return;
      await current.recorder.close();
    },
  };
}

/** Replay decks, with the provenance of the set they were loaded from. */
export interface ReplayDecks extends TrialDecks {
  provenance(): ReplayProvenance;
  /**
   * The model ids the headers recorded. Read from the set rather than from the
   * running configuration, so the report says what produced the decisions; the
   * player has already refused any header that differs from the configuration.
   */
  models(): ModelIds;
}

/**
 * Loads every cassette the run will play, before the first trial.
 *
 * Up front rather than per trial so that an incompatible set — a different chat
 * model, a different embedding width, a format version this player does not
 * read — refuses the run before it resets a database, and so that the report
 * can name the set it is about to replay.
 */
export function replayDecks(
  datasetDir: string,
  plan: readonly { readonly taskId: string; readonly trials: number }[],
): ReplayDecks {
  const players = new Map<string, CassettePlayer>();
  const config = {
    chatModel: CHAT_MODEL,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  };

  for (const task of plan) {
    if (task.trials === 0) {
      throw new Error(
        `EVAL_CASSETTE_MODE=replay, and \`${task.taskId}\` has no cassette in ` +
          `${cassettePath(datasetDir, task.taskId, 0)}. Record the set with ` +
          'EVAL_CASSETTE_MODE=record on the live model axis, or the task is unmeasurable here.',
      );
    }

    for (let index = 0; index < task.trials; index += 1) {
      const path = cassettePath(datasetDir, task.taskId, index);
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      players.set(key(task.taskId, index), playerFor(path, raw, config));
    }
  }

  let open: CassettePlayer | undefined;

  return {
    mode: 'replay',
    open(taskId, trialIndex) {
      const player = players.get(key(taskId, trialIndex));
      if (player === undefined) {
        throw new Error(`no cassette was loaded for ${taskId} trial ${trialIndex}`);
      }
      open = player;
      return player;
    },
    async close(completed) {
      const current = open;
      open = undefined;

      // Unconsumed decisions are not harmless. They mean the replayed run made
      // fewer calls than the recording did — a node that stopped embedding, a
      // loop that ran one step short — and a suite that passed anyway would be
      // grading a shorter run against the longer run's recording.
      if (current !== undefined && completed && current.remaining() > 0) {
        throw new Error(
          `replay left ${current.remaining()} recorded decision(s) unconsumed: the run made ` +
            'fewer model calls than the recording did, so it is not the run that was recorded',
        );
      }
    },
    provenance(): ReplayProvenance {
      const headers = [...players.values()].map((player) => player.header);
      const shas = [...new Set(headers.map((header) => header.gitSha))].sort();

      return {
        // The oldest, because the question the field answers is how stale the
        // set is rather than when it was last touched.
        recordedAt: headers.map((header) => header.recordedAt).sort()[0] ?? '',
        gitSha: shas.join(', '),
        cassettes: players.size,
      };
    },
    models(): ModelIds {
      const headers = [...players.values()].map((player) => player.header);
      const ids = (pick: (header: (typeof headers)[number]) => string): string =>
        [...new Set(headers.map(pick))].sort().join(', ');
      return {
        chat: ids((header) => header.chatModel),
        embedding: ids((header) => header.embeddingModel),
      };
    },
  };
}

/**
 * A player for one cassette, or a refusal that names the file and the command.
 *
 * The package says what is wrong with a cassette and nothing about this
 * repository's commands, which are the harness's. The fix for every refusal it
 * makes — an old format, another model, another embedding width — is the same
 * re-record, so the wiring is where the message learns it.
 */
function playerFor(path: string, raw: unknown, config: ReplayConfig): CassettePlayer {
  try {
    return new CassettePlayer(raw, config, { onServe: recordServedDecision });
  } catch (error) {
    if (!(error instanceof CassetteIncompatibleError)) throw error;
    const refusal = new CassetteIncompatibleError(
      error.reasons.map((reason) => `${path}: ${reason}`),
    );
    refusal.message +=
      `\nRe-record the set with \`${RE_RECORD_COMMAND}\` on the live model axis, then ` +
      `regenerate the replay baseline with \`${UPDATE_BASELINE_COMMAND}\`.`;
    throw refusal;
  }
}

function key(taskId: string, trialIndex: number): string {
  return `${taskId} ${trialIndex}`;
}

/** The host a model call goes to. Nothing else in a trial has business reaching it. */
export const MODEL_HOST = 'generativelanguage.googleapis.com';

/**
 * Every request that reached the model host, collected.
 *
 * Asserted at runtime rather than by reading the wiring, because "replay never
 * falls through to a live call" is the claim the whole mode rests on and the
 * cheapest way to be wrong about it is a client nobody remembered. `fetch` and
 * the LangChain client both go through undici, so one subscription covers both.
 *
 * Collected rather than thrown: the subscriber runs inside undici's own call
 * stack, where a throw surfaces as whatever that request decided to do with it.
 * The caller fails the run at the end, where the message survives.
 *
 * The one thing it cannot see is a request that never connects — the channel
 * publishes on dispatch — but a request that never connected also made no model
 * call, so the gap is on the safe side.
 */
export function watchForModelRequests(onViolation: (target: string) => void): () => string[] {
  const violations: string[] = [];

  subscribe('undici:request:create', (message) => {
    const request = (message as { request?: { origin?: unknown; path?: unknown } }).request;
    const origin = String(request?.origin ?? '');
    if (!origin.includes(MODEL_HOST)) return;

    const target = `${origin}${String(request?.path ?? '')}`;
    violations.push(target);
    onViolation(target);
  });

  return () => violations;
}
