import { bigint, boolean, json, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The prior-authorization case: one row per request `$submit` received (P3-E,
 * ADR 0010).
 *
 * The DDL is `migrations/0003_prior_auth_cases.sql`, hand-written because its
 * CHECK constraints and partial index are the point of it. This declaration is
 * what the repository queries through, and the integration suite fails if the
 * two disagree.
 *
 * `request` and `response` are `json`, not `jsonb`. They are FHIR documents as
 * received and as issued, and `jsonb` reorders keys and drops duplicates, so a
 * retried determination would be answered with a body that differs from the
 * first in key order. `disposition` and `determination` are domain values that
 * are parsed on every read, so `jsonb` is fine for them.
 */
export const priorAuthCases = pgTable('prior_auth_cases', {
  caseId: uuid('case_id').primaryKey(),
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull(),
  decisionDueBy: timestamp('decision_due_by', { withTimezone: true, mode: 'date' }).notNull(),
  memberId: text('member_id').notNull(),
  insurerId: text('insurer_id').notNull(),
  providerId: text('provider_id').notNull(),
  hcpcs: text('hcpcs').notNull(),
  request: json('request').notNull(),
  disposition: jsonb('disposition').notNull(),
  response: json('response').notNull(),
  recommendationSeq: bigint('recommendation_seq', { mode: 'number' }),
  determination: jsonb('determination'),
  reviewerId: text('reviewer_id'),
  reviewerKeyId: text('reviewer_key_id'),
  signature: text('signature'),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  overdueFlaggedAt: timestamp('overdue_flagged_at', { withTimezone: true, mode: 'date' }),
});

/**
 * A request for reconsideration of an adverse determination (P3-F, 42 CFR
 * Part 422, Subpart M).
 *
 * The DDL is `migrations/0004_prior_auth_appeals.sql`: a foreign key from
 * `(case_id, initial_reviewer_id)` to the case's reviewer, a CHECK that the
 * reviewer who signs is not that one, and a CHECK that each status carries
 * exactly its own columns. They hold whatever writes the row.
 *
 * `request`, the filer's statement and evidence, is `json` for the reason the
 * case's documents are. `filer`, `reconsideration` and `dismissal` are parsed
 * on every read, so `jsonb` is fine for them.
 */
export const priorAuthAppeals = pgTable('prior_auth_appeals', {
  appealId: uuid('appeal_id').primaryKey(),
  caseId: uuid('case_id').notNull(),
  initialReviewerId: text('initial_reviewer_id').notNull(),
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  filer: jsonb('filer').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull(),
  filingDeadline: timestamp('filing_deadline', { withTimezone: true, mode: 'date' }).notNull(),
  timely: boolean('timely').notNull(),
  reconsiderationDueBy: timestamp('reconsideration_due_by', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
  request: json('request').notNull(),
  reconsideration: jsonb('reconsideration'),
  reviewerId: text('reviewer_id'),
  reviewerKeyId: text('reviewer_key_id'),
  signature: text('signature'),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  dismissalReason: text('dismissal_reason'),
  dismissal: jsonb('dismissal'),
  forwardReason: text('forward_reason'),
  forwardedAt: timestamp('forwarded_at', { withTimezone: true, mode: 'date' }),
  caseFileDigest: text('case_file_digest'),
});
