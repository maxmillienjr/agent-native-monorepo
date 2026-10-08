import { bigint, json, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
