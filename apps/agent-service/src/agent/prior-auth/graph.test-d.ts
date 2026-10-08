/**
 * Type tests for the prior-authorization graph, checked by `tsc --noEmit`
 * under `yarn turbo typecheck` and never run.
 *
 * The nodes are typed with P3-A's `Node` alias over this graph's state, so an
 * inline node that returns an adverse value fails here as it does in the chat
 * graph (`disposition.test-d.ts`).
 */
import type { Node } from '../graph/node.js';
import type { PriorAuthState } from './state.js';

const denial = {
  kind: 'denial',
  specificReason: 'Synthetic fixture: an adverse value the agent may not hold.',
} as const;

// @ts-expect-error TS2322: `disposition` is an AgentDisposition, which has no denial member.
export const deniesInline: Node<PriorAuthState> = async () => ({ disposition: denial });

// @ts-expect-error TS2322: a determination is not a channel of this graph.
export const determinesInline: Node<PriorAuthState> = async () => ({ determination: denial });

export const refers: Node<PriorAuthState> = async () => ({
  disposition: { kind: 'refer-to-clinician', findings: [] },
});
