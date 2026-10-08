/**
 * Type tests, checked by `tsc --noEmit` under `yarn turbo typecheck` and never
 * run by Vitest (P3-F).
 *
 * `AppealRepository.reconsider` takes the branded `Reconsideration`, which
 * only `attestReconsideration` mints. An unbranded record, the reader schema's
 * output or an object literal, does not compile as its argument, so the one
 * way to record a reconsideration goes through the constructor that refuses
 * the initial reviewer. These live here rather than in
 * `determination.test-d.ts` because `@repo/determination` cannot import this
 * package without a cycle.
 */
import { expectTypeOf } from 'vitest';
import type { Reconsideration, ReconsiderationRecord } from '@repo/determination';
import type { AppealRepository, SignedAction } from './appeal.repo.js';

type Argument = Parameters<AppealRepository['reconsider']>[1];

expectTypeOf<Argument>().toEqualTypeOf<Reconsideration>();
expectTypeOf<ReconsiderationRecord>().not.toMatchTypeOf<Argument>();

declare const repo: AppealRepository;
declare const record: ReconsiderationRecord;
declare const signed: SignedAction;

// @ts-expect-error TS2345: a record the reader schema returns is not a Reconsideration.
void repo.reconsider('00000000-0000-4000-8000-000000000001', record, signed);

void repo.reconsider(
  '00000000-0000-4000-8000-000000000001',
  // @ts-expect-error TS2345: nor is a literal with every field, because the brand cannot be written.
  {
    kind: 'reversal',
    explanation: 'Synthetic fixture.',
    goodCauseFound: false,
    attestation: {
      reviewerId: 'synthetic-reviewer-002',
      credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
      attestedAt: '2026-10-02T09:00:00+00:00',
    },
    initialReviewerId: 'synthetic-reviewer-001',
  },
  signed,
);
