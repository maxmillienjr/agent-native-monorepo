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
  type ReplayConfig,
} from '@repo/agent-cassette';
import { activeInferenceSpan } from '@repo/telemetry';
import { CHAT_MODEL, type ModelDeps } from '../agent/model/model-deps.js';
import {
  recordingModelDeps,
  replayModelDeps,
  tokenCountsFor,
} from '../agent/model/decision-seam.js';
import { RE_RECORD_COMMAND, UPDATE_BASELINE_COMMAND } from './abort-cause.js';

/**
 * Cassettes, for evaluation trials.
 *
 * The seam itself — the request builders and `recordingModelDeps` /
 * `replayModelDeps` — is the agent's, in `src/agent/model/decision-seam.ts`,
 * because every production run records through it too (P3-B). What is left
 * here is what only an evaluation needs: one cassette per trial, the set's
 * provenance, the replayed spans' usage, and the watcher that fails a replay
 * which reached the model host.
 *
 * `packages/agent-cassette` depends on `zod` and nothing else in this
 * repository; `RunsService` takes a `(ModelDeps) => ModelDeps` and never learns
 * that a cassette exists.
 */

/**
 * What a replayed decision says about the span it is served inside.
 *
 * The player calls this from inside `resolve`, so the active span is the
 * inference or embeddings span `replayModelDeps` opened — or, at the
 * `act.tool` seam, the `execute_tool` span `act` opened. Each is marked
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

/**
 * The model decorator a harness installs on `RunsService`: the open trial's
 * deck, recording the live set through it or replaying from it, and the live
 * set untouched between trials. Both harnesses install this one, so the two
 * suites cannot record or replay differently.
 */
export function deckDecorator(openDeck: () => Deck | undefined): (live: ModelDeps) => ModelDeps {
  return (live) => {
    const deck = openDeck();
    if (deck === undefined) return live;
    return deck.mode === 'replay' ? replayModelDeps(deck) : recordingModelDeps(live, deck);
  };
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
