-- The decision ledger (P3-C): a hash chain of commitments, the salted payloads
-- they commit to, and the RFC 3161 tokens that anchor the chain outside the
-- database.
--
-- Hand-written. Its history is recorded in __ledger_migrations, not in
-- memory-core's table, so the ledger's schema can be migrated, audited and
-- lifted on its own. Applied by the table owner (`yarn ledger:migrate`); the
-- service writes as `ledger_writer`, which `roles.sql` grants SELECT and INSERT
-- and nothing else.
CREATE TABLE "ledger_entries" (
	"seq" bigint PRIMARY KEY NOT NULL CHECK ("seq" >= 0),
	-- Caller-supplied, so a retried append is idempotent: the same id with the
	-- same payload returns the stored entry, and with another payload throws.
	"entry_id" uuid NOT NULL UNIQUE,
	"kind" text NOT NULL,
	"recorded_at" timestamptz NOT NULL,
	-- 32 zero bytes at seq 0. UNIQUE forbids a fork: two entries cannot claim the
	-- same predecessor even if a writer bypassed the advisory lock.
	"prev_hash" bytea NOT NULL UNIQUE CHECK (octet_length("prev_hash") = 32),
	-- SHA-256(salt || payload).
	"commitment" bytea NOT NULL CHECK (octet_length("commitment") = 32),
	"entry_hash" bytea NOT NULL UNIQUE CHECK (octet_length("entry_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "ledger_payloads" (
	"entry_id" uuid PRIMARY KEY NOT NULL REFERENCES "ledger_entries" ("entry_id"),
	"salt" bytea NOT NULL CHECK (octet_length("salt") = 16),
	-- Text, not jsonb: the verifier must hash the exact bytes that were hashed,
	-- and jsonb normalises on the way in.
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_anchors" (
	"seq" bigint PRIMARY KEY NOT NULL REFERENCES "ledger_entries" ("seq"),
	"tsa_url" text NOT NULL,
	-- The DER TimeStampResp the authority returned, which `openssl ts -verify`
	-- reads as it is.
	"token" bytea NOT NULL,
	-- The token's genTime, as the authority stated it.
	"anchored_at" timestamptz NOT NULL
);
--> statement-breakpoint
-- History is not rewritten, by anyone the trigger binds: the service's role has
-- no UPDATE or DELETE grant to begin with, and this stops the owner too. It does
-- not stop a superuser who sets session_replication_role = replica, which is
-- why the chain is anchored outside the database (the PRD's threat model).
CREATE FUNCTION "ledger_refuse_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'the decision ledger is append-only: % on % is refused', TG_OP, TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only"
	BEFORE UPDATE OR DELETE ON "ledger_entries"
	FOR EACH ROW EXECUTE FUNCTION "ledger_refuse_rewrite"();
--> statement-breakpoint
CREATE TRIGGER "ledger_anchors_append_only"
	BEFORE UPDATE OR DELETE ON "ledger_anchors"
	FOR EACH ROW EXECUTE FUNCTION "ledger_refuse_rewrite"();
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_no_truncate"
	BEFORE TRUNCATE ON "ledger_entries"
	FOR EACH STATEMENT EXECUTE FUNCTION "ledger_refuse_rewrite"();
--> statement-breakpoint
CREATE TRIGGER "ledger_anchors_no_truncate"
	BEFORE TRUNCATE ON "ledger_anchors"
	FOR EACH STATEMENT EXECUTE FUNCTION "ledger_refuse_rewrite"();
--> statement-breakpoint
-- A payload may be deleted by the owner, so content can be withheld under a
-- retention or minimum-necessary policy while the entry that committed to it
-- stays; the verifier reports it withheld, not tampered. It may never be edited,
-- and a reviewer key's payload may never be withheld, because every later
-- attestation is checked against it.
CREATE FUNCTION "ledger_guard_payload"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	entry_kind text;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'the decision ledger is append-only: UPDATE on ledger_payloads is refused';
	END IF;
	SELECT "kind" INTO entry_kind FROM "ledger_entries" WHERE "entry_id" = OLD."entry_id";
	IF entry_kind LIKE 'reviewer-key.%' THEN
		RAISE EXCEPTION 'a reviewer key''s payload is never withheld (entry %)', OLD."entry_id";
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_payloads_guard"
	BEFORE UPDATE OR DELETE ON "ledger_payloads"
	FOR EACH ROW EXECUTE FUNCTION "ledger_guard_payload"();
--> statement-breakpoint
CREATE TRIGGER "ledger_payloads_no_truncate"
	BEFORE TRUNCATE ON "ledger_payloads"
	FOR EACH STATEMENT EXECUTE FUNCTION "ledger_refuse_rewrite"();
