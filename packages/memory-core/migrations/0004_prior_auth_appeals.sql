-- Requests for reconsideration of an adverse determination (P3-F), 42 CFR
-- Part 422, Subpart M. Hand-written as 0003 is, because the constraints are
-- the point of it.
--
-- A row is written when an appeal is filed, and updated once more, when it
-- is reversed, forwarded or dismissed. `request` is `json` so the filer's
-- statement and evidence keep the bytes they were received with.
--
-- Every comparison that could meet a NULL is written so it cannot: a CHECK
-- whose expression is NULL passes, and a state check that passed on a NULL
-- would hold nothing.

-- The foreign key's target. `case_id` is already the key, so the pair is
-- unique by construction; the constraint is what lets an appeal reference the
-- reviewer a case was decided by.
ALTER TABLE "prior_auth_cases"
	ADD CONSTRAINT "prior_auth_cases_case_reviewer" UNIQUE ("case_id", "reviewer_id");
--> statement-breakpoint
CREATE TABLE "prior_auth_appeals" (
	"appeal_id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"initial_reviewer_id" text NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"filer" jsonb NOT NULL,
	"received_at" timestamptz NOT NULL,
	"filing_deadline" timestamptz NOT NULL,
	"timely" boolean NOT NULL,
	"reconsideration_due_by" timestamptz NOT NULL,
	"request" json NOT NULL,
	"reconsideration" jsonb,
	"reviewer_id" text,
	"reviewer_key_id" text,
	"signature" text,
	"decided_at" timestamptz,
	"dismissal_reason" text,
	"dismissal" jsonb,
	"forward_reason" text,
	"forwarded_at" timestamptz,
	"case_file_digest" text,
	-- The appeal names the reviewer who decided the case, and nothing else can
	-- be written there: the pair must exist on a decided case. Rewriting the
	-- case's reviewer under an appeal fails here too.
	CONSTRAINT "prior_auth_appeals_initial" FOREIGN KEY ("case_id", "initial_reviewer_id")
		REFERENCES "prior_auth_cases" ("case_id", "reviewer_id"),
	-- § 422.590(h)(1): whoever signs the reconsideration or the dismissal did
	-- not make the determination under reconsideration.
	CONSTRAINT "prior_auth_appeals_not_involved" CHECK ("reviewer_id" IS DISTINCT FROM "initial_reviewer_id"),
	CONSTRAINT "prior_auth_appeals_clock" CHECK ("reconsideration_due_by" > "received_at"),
	CONSTRAINT "prior_auth_appeals_status" CHECK ("status" IN ('filed', 'reversed', 'forwarded', 'dismissed')),
	CONSTRAINT "prior_auth_appeals_priority" CHECK ("priority" IN ('expedited', 'standard')),
	CONSTRAINT "prior_auth_appeals_dismissal_reason" CHECK (
		"dismissal_reason" IS NULL
		OR "dismissal_reason" IN ('not-a-proper-party', 'invalid-request', 'untimely', 'withdrawn')
	),
	CONSTRAINT "prior_auth_appeals_forward_reason" CHECK (
		"forward_reason" IS NULL OR "forward_reason" IN ('affirmed', 'deadline-lapsed')
	),
	-- Each status carries exactly its own columns. There is no affirmed
	-- state: an affirmation is forwarded in the transaction that records it,
	-- so nothing can hold one without the other.
	CONSTRAINT "prior_auth_appeals_state" CHECK (
		(
			"status" = 'filed'
			AND "reconsideration" IS NULL AND "reviewer_id" IS NULL AND "reviewer_key_id" IS NULL
			AND "signature" IS NULL AND "decided_at" IS NULL
			AND "dismissal_reason" IS NULL AND "dismissal" IS NULL
			AND "forward_reason" IS NULL AND "forwarded_at" IS NULL AND "case_file_digest" IS NULL
		) OR (
			"status" = 'reversed'
			AND "reconsideration" IS NOT NULL
			AND ("reconsideration" ->> 'kind') IS NOT DISTINCT FROM 'reversal'
			AND "reviewer_id" IS NOT NULL AND "reviewer_key_id" IS NOT NULL
			AND "signature" IS NOT NULL AND "decided_at" IS NOT NULL
			AND "dismissal_reason" IS NULL AND "dismissal" IS NULL
			AND "forward_reason" IS NULL AND "forwarded_at" IS NULL AND "case_file_digest" IS NULL
		) OR (
			"status" = 'forwarded'
			AND "forward_reason" IS NOT DISTINCT FROM 'affirmed'
			AND "reconsideration" IS NOT NULL
			AND ("reconsideration" ->> 'kind') IS NOT DISTINCT FROM 'affirmation'
			AND "reviewer_id" IS NOT NULL AND "reviewer_key_id" IS NOT NULL
			AND "signature" IS NOT NULL AND "decided_at" IS NOT NULL
			AND "dismissal_reason" IS NULL AND "dismissal" IS NULL
			AND "forwarded_at" IS NOT NULL AND "case_file_digest" IS NOT NULL
		) OR (
			"status" = 'forwarded'
			AND "forward_reason" IS NOT DISTINCT FROM 'deadline-lapsed'
			AND "reconsideration" IS NULL AND "reviewer_id" IS NULL AND "reviewer_key_id" IS NULL
			AND "signature" IS NULL AND "decided_at" IS NULL
			AND "dismissal_reason" IS NULL AND "dismissal" IS NULL
			AND "forwarded_at" IS NOT NULL AND "case_file_digest" IS NOT NULL
		) OR (
			"status" = 'dismissed'
			AND "reconsideration" IS NULL
			AND "reviewer_id" IS NOT NULL AND "reviewer_key_id" IS NOT NULL
			AND "signature" IS NOT NULL AND "decided_at" IS NOT NULL
			AND "dismissal_reason" IS NOT NULL AND "dismissal" IS NOT NULL
			AND "forward_reason" IS NULL AND "forwarded_at" IS NULL AND "case_file_digest" IS NULL
		)
	),
	-- The signed record agrees with the columns the other constraints read,
	-- so the reviewer in the JSON cannot differ from the one checked above.
	CONSTRAINT "prior_auth_appeals_signed_record" CHECK (
		(
			"reconsideration" IS NULL
			OR (
				("reconsideration" -> 'attestation' ->> 'reviewerId') IS NOT DISTINCT FROM "reviewer_id"
				AND ("reconsideration" ->> 'initialReviewerId') IS NOT DISTINCT FROM "initial_reviewer_id"
			)
		) AND (
			"dismissal" IS NULL
			OR (
				("dismissal" -> 'attestation' ->> 'reviewerId') IS NOT DISTINCT FROM "reviewer_id"
				AND ("dismissal" ->> 'reason') IS NOT DISTINCT FROM "dismissal_reason"
			)
		)
	)
);
--> statement-breakpoint
-- One appeal in flight per case. A dismissed appeal does not block a new
-- filing, so an enrollee is not locked out by a dismissal.
CREATE UNIQUE INDEX "prior_auth_appeals_one_open" ON "prior_auth_appeals" ("case_id")
	WHERE "status" <> 'dismissed';
--> statement-breakpoint
-- The appeal queue and the lapse sweep, in clock order: the same three keys as
-- `compareCases` over the reconsideration deadline, over filed appeals only.
CREATE INDEX "prior_auth_appeals_queue" ON "prior_auth_appeals" ("reconsideration_due_by", "received_at", "appeal_id")
	WHERE "status" = 'filed';
