import type { ActNodeDeps } from '../nodes/act.node.js';
import type { DistillNodeDeps } from '../nodes/distill.node.js';
import type { PlanNodeDeps } from '../nodes/plan.node.js';
import type { AssessDeps } from '../prior-auth/assessment.js';

/**
 * The chat model the service is pinned to, named once.
 *
 * "Pinned" is the stable id: `gemini-2.5-flash` has no dated variant to pin to,
 * and `models.get` reports its version as `001`. Whether the model behind it
 * stays the same is what the drift canary watches (P1-E).
 */
export const PINNED_CHAT_MODEL = 'gemini-2.5-flash';

/**
 * The chat model this process runs, resolved once at module load.
 *
 * A cassette header records it and the player refuses a set recorded against a
 * different one, so the string has to be readable from outside the service —
 * a second spelling of it in the eval wiring would make that check pass while
 * being wrong. A run record's header records it too (P3-B).
 *
 * `EVAL_CHAT_MODEL` overrides it for a live suite run started by hand on
 * another id — the floating alias, as a migration comparison. Every reader
 * (both clients, the recorder header, the replay check, the report) takes this
 * one value, so an overridden run names the id it ran on, and a replay under
 * an override is refused by the player before any store is reset.
 */
export const CHAT_MODEL = process.env['EVAL_CHAT_MODEL'] || PINNED_CHAT_MODEL;

/**
 * The model half of a dependency set: everything that costs a model call.
 *
 * `assess` is the prior-authorization graph's (P3-D). It lives here rather
 * than in a second set so that both graphs take their model from one axis
 * switch and one decorator, and a cassette records either graph's decisions
 * without the service learning which one it is serving.
 *
 * It is in `src/agent/model` rather than beside `RunsService` because the
 * decision seam is written against it (`decision-seam.ts`), and the service
 * imports the seam to record every production run.
 */
export interface ModelDeps {
  plan: PlanNodeDeps;
  act: ActNodeDeps;
  distill: DistillNodeDeps;
  embed: (text: string) => Promise<number[]>;
  assess: AssessDeps;
}

/**
 * The tool registry, which is the one thing in `ModelDeps` that costs no model
 * call.
 *
 * It is built here rather than twice inside the two axis branches because a
 * replayed dependency set needs the same registry the recorded run had: the
 * `act.selectTool` request carries the tool names, so a replay whose tool list
 * differs from the recording's misses on the hash before it gets anywhere near
 * a tool.
 *
 * The one registered tool is a pure function. A registry that holds tools which
 * change the world needs reversibility tiers before a cassette of one is safe,
 * and that is P4-C's.
 */
export function defaultTools(): ActNodeDeps['tools'] {
  return [
    {
      name: 'web-search',
      execute: async (input) => ({ results: [`Result for: ${JSON.stringify(input)}`] }),
    },
  ];
}
