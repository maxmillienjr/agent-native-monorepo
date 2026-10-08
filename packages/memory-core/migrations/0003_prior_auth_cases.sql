-- The prior-authorization case layer (P3-E, ADR 0010). Hand-written rather
-- than generated, because the CHECK constraints and the partial index are the
-- point of it and drizzle-kit would not emit them from `src/cases/schema.ts`.
--
-- A row is written by `$submit` before it answers, and updated once, when a
-- clinician decides. `request` and `response` are `json` so the documents keep
-- the bytes they were received and issued with; see `schema.ts`.
CREATE TABLE "prior_auth_cases" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"received_at" timestamptz NOT NULL,
	"decision_due_by" timestamptz NOT NULL,
	"member_id" text NOT NULL,
	"insurer_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"hcpcs" text NOT NULL,
	"request" json NOT NULL,
	"disposition" jsonb NOT NULL,
	"response" json NOT NULL,
	"recommendation_seq" bigint,
	"determination" jsonb,
	"reviewer_id" text,
	"reviewer_key_id" text,
	"signature" text,
	"decided_at" timestamptz,
	"overdue_flagged_at" timestamptz,
	CONSTRAINT "prior_auth_cases_status" CHECK ("status" IN ('approved-automated', 'pended', 'decided')),
	CONSTRAINT "prior_auth_cases_priority" CHECK ("priority" IN ('expedited', 'standard')),
	CONSTRAINT "prior_auth_cases_clock" CHECK ("decision_due_by" > "received_at"),
	-- A decided row carries everything that decided it, and no other row
	-- carries any of it, so a determination cannot be half-written.
	CONSTRAINT "prior_auth_cases_decided" CHECK (
		("status" = 'decided') = (
			"determination" IS NOT NULL
			AND "reviewer_id" IS NOT NULL
			AND "reviewer_key_id" IS NOT NULL
			AND "signature" IS NOT NULL
			AND "decided_at" IS NOT NULL
		)
		AND ("status" = 'decided' OR (
			"determination" IS NULL
			AND "reviewer_id" IS NULL
			AND "reviewer_key_id" IS NULL
			AND "signature" IS NULL
			AND "decided_at" IS NULL
		))
	)
);
--> statement-breakpoint
-- The review queue, in clock order and nothing else: the same three keys as
-- `compareCases` in `@repo/prior-auth`, over pended cases only.
CREATE INDEX "prior_auth_cases_queue" ON "prior_auth_cases" ("decision_due_by", "received_at", "case_id")
	WHERE "status" = 'pended';
--> statement-breakpoint
-- `$inquire` matches by example on the member, the insurer and the provider.
CREATE INDEX "prior_auth_cases_inquiry" ON "prior_auth_cases" ("member_id", "insurer_id", "provider_id");
