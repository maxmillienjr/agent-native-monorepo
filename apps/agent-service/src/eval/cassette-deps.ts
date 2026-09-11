import { execFileSync } from 'node:child_process';
import { subscribe } from 'node:diagnostics_channel';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@repo/memory-core';
import { cassettePath, type Axes, type ReplayProvenance } from '@repo/eval-harness';
import {
  CassettePlayer,
  CassetteRecorder,
  type Deck,
  type DecisionCall,
  type TokenCounts,
} from '@repo/agent-cassette';
import { CHAT_MODEL, defaultTools, type ModelDeps } from '../runs/runs.service.js';

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
  selectTool: (plan: string, toolNames: readonly string[]): DecisionCall => ({
    seam: 'act.selectTool',
    request: { plan, toolNames: [...toolNames] },
  }),
  tool: (name: string, input: unknown): DecisionCall => ({
    seam: 'act.tool',
    label: name,
    request: input,
  }),
  extract: (context: string): DecisionCall => ({
    seam: 'distill.extractEntities',
    request: { context },
  }),
  embed: (text: string): DecisionCall => ({ seam: 'embed', request: { text } }),
} as const;

/**
 * The only seam whose response carries usage metadata by the time it gets here.
 *
 * `selectTool` and `extractEntities` both go through a JSON model call inside
 * `RunsService` and return the parsed value, so their token counts are gone
 * before this wrapper sees them. P1-F owns cost assertions and will want them;
 * recording what is reachable now is free, and claiming the rest would not be.
 */
export function tokenCountsFor(call: DecisionCall, response: unknown): TokenCounts | undefined {
  if (call.seam !== 'plan.callLlm') return undefined;
  const counts = (response as { tokenCounts?: TokenCounts } | null | undefined)?.tokenCounts;
  return counts === undefined ? undefined : counts;
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
      tools: live.act.tools.map((tool) => ({
        name: tool.name,
        execute: (input) => deck.resolve(calls.tool(tool.name, input), () => tool.execute(input)),
      })),
      selectTool: (plan, tools) =>
        deck.resolve(
          calls.selectTool(
            plan,
            tools.map((tool) => tool.name),
          ),
          () => live.act.selectTool(plan, tools),
        ),
    },
    distill: {
      extractEntities: (context) =>
        deck.resolve(calls.extract(context), () => live.distill.extractEntities(context)),
    },
    embed: (text) => deck.resolve(calls.embed(text), () => live.embed(text)),
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
 * The tool registry comes from `defaultTools` because the recorded
 * `act.selectTool` request carries the tool names. Rebuilding the list from the
 * cassette's own `act.tool` entries would give a run that selected no tool an
 * empty registry, and the recorded request would then miss on its own hash.
 */
export function replayModelDeps(deck: Deck): ModelDeps {
  const unreachable = (): Promise<never> => {
    throw new Error(
      'a replayed dependency set tried to make a live call, which should be unreachable: ' +
        'the player never calls the thunk and no model client was constructed',
    );
  };

  return {
    plan: {
      callLlm: (systemPrompt, userPrompt) =>
        deck.resolve(calls.plan(systemPrompt, userPrompt), unreachable),
    },
    act: {
      tools: defaultTools().map((tool) => ({
        name: tool.name,
        execute: (input) => deck.resolve(calls.tool(tool.name, input), unreachable),
      })),
      selectTool: (plan, tools) =>
        deck.resolve(
          calls.selectTool(
            plan,
            tools.map((tool) => tool.name),
          ),
          unreachable,
        ),
    },
    distill: {
      extractEntities: (context) => deck.resolve(calls.extract(context), unreachable),
    },
    embed: (text) => deck.resolve(calls.embed(text), unreachable),
  };
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
          formatVersion: 1,
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
      players.set(key(task.taskId, index), new CassettePlayer(raw, config));
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
  };
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
