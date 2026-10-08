/**
 * Type tests. `tsc --noEmit` checks this file — `yarn turbo typecheck` in CI —
 * and Vitest never runs it (its include is `*.test.ts`). Both mechanisms here
 * fail plain `tsc`: an `@ts-expect-error` whose line compiles is TS2578, and a
 * false `expectTypeOf` assertion is a type error at the call.
 */
import { expectTypeOf } from 'vitest';
import { attestAdverseDetermination, attestReconsideration } from './clinician.js';
import type {
  AdverseDetermination,
  AgentDisposition,
  AutomatedApproval,
  Determination,
  Reconsideration,
  ReconsiderationRecord,
} from './determination.js';
import {
  SYNTHETIC_ATTESTATION,
  SYNTHETIC_DENIAL_INPUT,
  SYNTHETIC_RECONSIDERING_ATTESTATION,
  SYNTHETIC_REVERSAL_INPUT,
} from './fixtures.js';

// --- An adverse determination has one constructor ---------------------------

// @ts-expect-error TS2741: a literal cannot carry the unexported brand, so it is not an AdverseDetermination.
export const forgedDenial: AdverseDetermination = {
  ...SYNTHETIC_DENIAL_INPUT,
  attestation: SYNTHETIC_ATTESTATION,
};

// @ts-expect-error TS2554: a denial without an attestation is not a call the constructor accepts.
export const unattestedDenial = attestAdverseDetermination(SYNTHETIC_DENIAL_INPUT);

export const attestedDenial = attestAdverseDetermination(
  SYNTHETIC_DENIAL_INPUT,
  SYNTHETIC_ATTESTATION,
);
expectTypeOf(attestedDenial).toEqualTypeOf<AdverseDetermination>();
expectTypeOf(attestedDenial).toMatchTypeOf<Determination>();

// --- The agent's type has no adverse member ---------------------------------

// @ts-expect-error TS2322: an adverse determination is not something the agent may hold.
export const agentDenial: AgentDisposition = attestedDenial;

expectTypeOf<AdverseDetermination>().not.toMatchTypeOf<AgentDisposition>();
expectTypeOf<Extract<AgentDisposition, { kind: 'denial' | 'partial-approval' }>>().toBeNever();

// --- An automated approval approves what was asked, and nothing less --------

export const reducedApproval: AutomatedApproval = {
  kind: 'automated-approval',
  criteriaMet: ['synthetic-criterion-1'],
  // @ts-expect-error TS2353: there is no field to approve less than was requested; that is a partial-approval.
  approvedUnits: 1,
};

// --- Nothing in the barrel mints one ----------------------------------------

/**
 * What an export produces: a function's awaited return, or a schema's parse
 * result. Anything else produces nothing.
 */
type Produces<T> = T extends (...args: never[]) => infer R
  ? Awaited<R>
  : T extends { parse: (...args: never[]) => infer P }
    ? P
    : never;

/** The union, over every export of a module, of whatever it produces that is an AdverseDetermination. */
type MintedBy<M> = { [K in keyof M]: Extract<Produces<M[K]>, AdverseDetermination> }[keyof M];

expectTypeOf<MintedBy<typeof import('./index.js')>>().toBeNever();

// The check is not vacuous: the same mapping over `./clinician` finds its constructor.
expectTypeOf<MintedBy<typeof import('./clinician.js')>>().toEqualTypeOf<AdverseDetermination>();

// --- A reconsideration has one constructor too (P3-F) -----------------------

// @ts-expect-error TS2741: a literal cannot carry the unexported brand, so it is not a Reconsideration.
export const forgedReconsideration: Reconsideration = {
  ...SYNTHETIC_REVERSAL_INPUT,
  attestation: SYNTHETIC_RECONSIDERING_ATTESTATION,
  initialReviewerId: SYNTHETIC_ATTESTATION.reviewerId,
};

export const byReviewerId = attestReconsideration(
  // @ts-expect-error TS2345: the constructor takes the stored denial, not a bare reviewer id.
  'synthetic-reviewer-001',
  SYNTHETIC_REVERSAL_INPUT,
  SYNTHETIC_RECONSIDERING_ATTESTATION,
);

export const reconsidered = attestReconsideration(
  attestedDenial,
  SYNTHETIC_REVERSAL_INPUT,
  SYNTHETIC_RECONSIDERING_ATTESTATION,
);
expectTypeOf(reconsidered).toEqualTypeOf<Reconsideration>();
expectTypeOf<ReconsiderationRecord>().not.toMatchTypeOf<Reconsideration>();

/** The union, over every export of a module, of whatever it produces that is a Reconsideration. */
type ReconsideredBy<M> = { [K in keyof M]: Extract<Produces<M[K]>, Reconsideration> }[keyof M];

expectTypeOf<ReconsideredBy<typeof import('./index.js')>>().toBeNever();
expectTypeOf<ReconsideredBy<typeof import('./clinician.js')>>().toEqualTypeOf<Reconsideration>();
