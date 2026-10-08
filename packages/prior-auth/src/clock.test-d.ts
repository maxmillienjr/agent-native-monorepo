/**
 * Type tests, checked by `tsc --noEmit` under `yarn turbo typecheck` and never
 * run by Vitest.
 *
 * The deadline is a function of receipt and priority alone. If a parameter is
 * added — a disposition, a finding, a "pended at" — this assertion fails, and
 * the reviewer has to decide whether P3-D's reading of SB 1120 still holds.
 */
import { expectTypeOf } from 'vitest';
import { decisionDueBy, type Priority } from './clock.js';
import type { AgentDisposition } from '@repo/determination';

expectTypeOf<Parameters<typeof decisionDueBy>>().toEqualTypeOf<[Date, Priority]>();
expectTypeOf<ReturnType<typeof decisionDueBy>>().toEqualTypeOf<Date>();

// @ts-expect-error TS2345: a disposition is not a priority, so the agent's output cannot move the deadline.
decisionDueBy(new Date(), { kind: 'refer-to-clinician', findings: [] } satisfies AgentDisposition);
