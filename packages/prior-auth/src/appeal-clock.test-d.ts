/**
 * Type tests, checked by `tsc --noEmit` under `yarn turbo typecheck` and never
 * run by Vitest.
 *
 * The reconsideration deadline is a function of receipt and priority alone
 * (P3-F). If a parameter is added — a finding, a filer's role, how late the
 * filing was — this assertion fails, and the reviewer has to decide whether
 * P3-D's reading of SB 1120 still holds for the second clock.
 */
import { expectTypeOf } from 'vitest';
import { isLapsed, reconsiderationDueBy } from './appeal-clock.js';
import type { Priority } from './clock.js';
import type { AgentDisposition } from '@repo/determination';

expectTypeOf<Parameters<typeof reconsiderationDueBy>>().toEqualTypeOf<[Date, Priority]>();
expectTypeOf<ReturnType<typeof reconsiderationDueBy>>().toEqualTypeOf<Date>();

reconsiderationDueBy(
  new Date(),
  // @ts-expect-error TS2345: a disposition is not a priority, so the agent's output cannot move the deadline.
  { kind: 'refer-to-clinician', findings: [] } satisfies AgentDisposition,
);

expectTypeOf<Parameters<typeof isLapsed>>().toEqualTypeOf<
  [{ readonly reconsiderationDueBy: Date }, Date]
>();
