-- The run record (P3-B, ADR 0007): what a production run received and decided,
-- kept beside the checkpoints that trace it. The checkpoints hold the state after
-- every super-step and not the request, the retries or the retrieval reads, so a
-- history on its own cannot be replayed; this is the rest.
--
-- Hand-written, like 0001. It is not a memory tier and nothing in the graph reads
-- it: `RunsService` and the prior-authorization service write it, and
-- `audit:replay` reads it.
--
-- Additive only, from here on. Replay runs at the commit that wrote a record, so
-- an old build has to read the schema a newer one migrated to. A new column is
-- nullable or defaulted; nothing is renamed, retyped or dropped. That is also why
-- `graph`, `model_axis` and `outcome` carry no CHECK: widening an enum would mean
-- dropping a constraint, and the values are validated by `RunRecordSchema` on the
-- way in and on the way out.
CREATE TABLE "run_records" (
	-- The checkpoint thread_id: the chat graph's runId, or the prior-authorization
	-- graph's caseId.
	"run_id" uuid PRIMARY KEY NOT NULL,
	-- Which compiled graph ran: 'chat' or 'prior-auth'.
	"graph" text NOT NULL,
	-- Null on the prior-authorization graph, which has no session.
	"session_id" uuid,
	"correlation_id" text NOT NULL,
	-- The body as received, before any parse.
	"request" jsonb NOT NULL,
	-- Null only on a build with no GIT_SHA and no .git; replay refuses such a record.
	"git_sha" text,
	-- Null when the sha came from the build argument and the tree is not known.
	"git_dirty" boolean,
	"chat_model" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	-- What served the model half: 'live', 'stub' or 'replay'.
	"model_axis" text NOT NULL,
	-- When the service received the request, by its clock. The
	-- prior-authorization graph's `receivedAt` is this value, so it is an input
	-- and not only a timestamp.
	"started_at" timestamptz DEFAULT now() NOT NULL,
	-- Null while running, and left null when an append failed on the chat path,
	-- so that a record with a gap can be found by a query.
	"finished_at" timestamptz,
	-- 'success', 'partial' or 'error'; null while running.
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "run_decisions" (
	"run_id" uuid NOT NULL REFERENCES "run_records" ("run_id"),
	-- The order the decisions resolved in, from 0.
	"ordinal" integer NOT NULL CHECK ("ordinal" >= 0),
	-- The cassette format the decision was written in, so an older row stays
	-- readable after the format moves.
	"format_version" integer NOT NULL,
	-- A DecisionSchema value from @repo/agent-cassette, at one of its seams or at
	-- memory.retrieve.
	"decision" jsonb NOT NULL,
	PRIMARY KEY ("run_id", "ordinal")
);
