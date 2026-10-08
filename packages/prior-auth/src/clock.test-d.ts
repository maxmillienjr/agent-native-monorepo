/**
 * Type tests, checked by `tsc --noEmit` under `yarn turbo typecheck` and never
 * run by Vitest.
 *
 * The deadline is a function of receipt and priority alone. If a parameter is
 * added — a disposition, a finding, a "pended at" — this assertion fails, and
 * the reviewer has to decide whether P3-D's reading of SB 1120 still holds.
 */
import { expectTypeOf } from 'vitest';
import { compareCases, decisionDueBy, type Priority, type QueueKey } from './clock.js';
import type { AgentDisposition } from '@repo/determination';

expectTypeOf<Parameters<typeof decisionDueBy>>().toEqualTypeOf<[Date, Priority]>();
expectTypeOf<ReturnType<typeof decisionDueBy>>().toEqualTypeOf<Date>();

// @ts-expect-error TS2345: a disposition is not a priority, so the agent's output cannot move the deadline.
decisionDueBy(new Date(), { kind: 'refer-to-clinician', findings: [] } satisfies AgentDisposition);

// The queue sorts on the clock alone (P3-E). A key added to QueueKey — a
// finding, a disposition, a referral reason — fails here, and so does one
// removed, and the reviewer has to decide whether the SB 1120 reading holds.
expectTypeOf<keyof QueueKey>().toEqualTypeOf<'caseId' | 'receivedAt' | 'decisionDueBy'>();
expectTypeOf<QueueKey>().toEqualTypeOf<{
  readonly caseId: string;
  readonly receivedAt: Date;
  readonly decisionDueBy: Date;
}>();
expectTypeOf<Parameters<typeof compareCases>>().toEqualTypeOf<[QueueKey, QueueKey]>();
expectTypeOf<Parameters<typeof compareCases>[0]>().toEqualTypeOf<QueueKey>();
