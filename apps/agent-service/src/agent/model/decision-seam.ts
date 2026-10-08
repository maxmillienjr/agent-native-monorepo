import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@repo/memory-core';
import type { Deck, DecisionCall, TokenCounts } from '@repo/agent-cassette';
import { withInferenceSpan, type InferenceRequest, type InferenceSeam } from '@repo/telemetry';
import type { EvidenceItem, PolicyCriterion } from '@repo/prior-auth';
import type { ActNodeDeps } from '../nodes/act.node.js';
import type { DistillNodeDeps } from '../nodes/distill.node.js';
import type { PlanNodeDeps } from '../nodes/plan.node.js';
import type { AssessDeps } from '../prior-auth/assessment.js';
import { CHAT_MODEL, defaultTools, type ModelDeps } from './model-deps.js';

/**
 * The decision seam (ADR 0005), in both directions, for evaluation and for
 * production.
 *
 * A `Deck` sits between a graph and the dependencies that decide what it does.
 * Evaluation puts a cassette there (`src/eval/cassette-deps.ts`); every
 * production run on the configured memory axis puts a run record there
 * (`src/audit/`, P3-B). Both record through this file, so one call has one
 * spelling of its request and one hash, whichever artifact it lands in.
 *
 * The seam belongs to the agent, not to the cassette package and not to the
 * eval wiring: `packages/agent-cassette` knows nothing about what a plan or a
 * retrieval looks like, and the service must not import from `src/eval/`.
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
export const calls = {
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
  assess: (
    criteria: readonly PolicyCriterion[],
    evidence: readonly EvidenceItem[],
  ): DecisionCall => ({
    seam: 'assess.criteria',
    request: { criteria: [...criteria], evidence: [...evidence] },
  }),
} as const;

/** The three seams that are a `generateContent` call, and so carry usage. */
const CHAT_SEAMS: ReadonlySet<string> = new Set([
  'plan.callLlm',
  'act.selectTool',
  'distill.extractEntities',
]);

/**
 * The usage a chat seam returned beside its answer.
 *
 * Every chat seam returns `{ ..., tokenCounts }` from format 2 on (P1-F), so
 * the recorder reads it at all three. `embed`, `act.tool` and
 * `memory.retrieve` report none, and none is claimed for them.
 */
export function tokenCountsFor(
  call: DecisionCall<string>,
  response: unknown,
): TokenCounts | undefined {
  if (!CHAT_SEAMS.has(call.seam)) return undefined;
  return (response as { tokenCounts?: TokenCounts } | null | undefined)?.tokenCounts;
}

/*
 * One recording wrapper per part of a dependency set. `recordingModelDeps`
 * and `recordingGraphDeps` are assembled from the same ones, so a call is
 * recorded identically whether a cassette or a run record is listening.
 */

function recordPlan(live: PlanNodeDeps, deck: Deck): PlanNodeDeps {
  return {
    callLlm: (systemPrompt, userPrompt) =>
      deck.resolve(calls.plan(systemPrompt, userPrompt), () =>
        live.callLlm(systemPrompt, userPrompt),
      ),
  };
}

function recordAct(live: ActNodeDeps, deck: Deck): ActNodeDeps {
  return {
    tools: live.tools.map((tool) => ({
      name: tool.name,
      execute: (input) => deck.resolve(calls.tool(tool.name, input), () => tool.execute(input)),
    })),
    selectTool: (plan, tools) =>
      deck.resolve(
        calls.selectTool(
          plan,
          tools.map((tool) => tool.name),
        ),
        () => live.selectTool(plan, tools),
      ),
  };
}

function recordDistill(live: DistillNodeDeps, deck: Deck): DistillNodeDeps {
  return {
    extractEntities: (context) =>
      deck.resolve(calls.extract(context), () => live.extractEntities(context)),
  };
}

function recordEmbed(
  live: (text: string) => Promise<number[]>,
  deck: Deck,
): (text: string) => Promise<number[]> {
  return (text) => deck.resolve(calls.embed(text), () => live(text));
}

/** The prior-authorization graph's one call, recorded. */
export function recordingAssess(live: AssessDeps, deck: Deck): AssessDeps {
  return {
    assessCriteria: (criteria, evidence) =>
      deck.resolve(calls.assess(criteria, evidence), () => live.assessCriteria(criteria, evidence)),
  };
}

/** Recording: the live set, with every decision it makes appended to the deck. */
export function recordingModelDeps(live: ModelDeps, deck: Deck): ModelDeps {
  return {
    plan: recordPlan(live.plan, deck),
    act: recordAct(live.act, deck),
    distill: recordDistill(live.distill, deck),
    embed: recordEmbed(live.embed, deck),
    assess: recordingAssess(live.assess, deck),
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
      tools: defaultTools().map((tool) => ({
        name: tool.name,
        execute: (input) => deck.resolve(calls.tool(tool.name, input), unreachable),
      })),
      selectTool: (plan, tools) =>
        withInferenceSpan(chat('act.selectTool', true), () =>
          deck.resolve(
            calls.selectTool(
              plan,
              tools.map((tool) => tool.name),
            ),
            unreachable,
          ),
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

function unreachable(): Promise<never> {
  throw new Error(
    'a replayed dependency set tried to make a live call, which should be unreachable: ' +
      'the player never calls the thunk and no model client was constructed',
  );
}
