/**
 * Type tests for `Node`, checked by `tsc --noEmit` (`yarn turbo typecheck`)
 * and never run by Vitest, whose include is `*.test.ts`.
 *
 * The chat graph has no `disposition` channel — P3-D adds one to its own graph
 * — so these run against a fixture annotation that has one, typed the way
 * P3-D's will be. An unused `@ts-expect-error` fails with TS2578.
 */
import { Annotation, StateGraph } from '@langchain/langgraph';
import type { AdverseDetermination, AgentDisposition } from '@repo/determination';
import type { Node } from './node.js';

const FixtureAnnotation = Annotation.Root({
  outcome: Annotation<'success' | 'error' | undefined>,
  disposition: Annotation<AgentDisposition | undefined>,
});
type FixtureState = typeof FixtureAnnotation.State;

declare const denial: AdverseDetermination;

// @ts-expect-error TS2322: a node cannot put an adverse determination in the disposition channel.
export const deniesInState: Node<FixtureState> = async () => ({ disposition: denial });

// @ts-expect-error TS2322: nor under a key the state does not declare.
export const deniesBesideState: Node<FixtureState> = async () => ({ determination: denial });

// An undeclared key beside a declared one is the case `Node` alone misses: a
// contextually typed arrow's literal gets no excess-property check. An inline
// node that returns a literal therefore also declares its return type, as
// every node file does, and that annotation is what this line exercises.
export const deniesBesideAnOutcome: Node<FixtureState> = async (): ReturnType<
  Node<FixtureState>
> => ({
  outcome: 'success',
  // @ts-expect-error TS2353: an explicit return type rejects the undeclared key beside a declared one.
  determination: denial,
});

// What a node may write: a referral, or an approval.
export const refers: Node<FixtureState> = async () => ({
  disposition: { kind: 'refer-to-clinician', findings: [] },
});

// The gate holds where nodes are registered, for a node written inline.
export const graph = new StateGraph(FixtureAnnotation).addNode(
  'dispose',
  // @ts-expect-error TS2322: `satisfies Node` checks an inline node the same way.
  (async () => ({ disposition: denial })) satisfies Node<FixtureState>,
);

// @ts-expect-error TS2307: the exports map does not expose dist/, so the constructor is not reachable by path.
import type * as DeepClinician from '@repo/determination/dist/clinician.js';
export type Unreachable = typeof DeepClinician;
