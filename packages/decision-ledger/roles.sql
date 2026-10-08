-- The ledger's writer (P3-C): SELECT and INSERT on the three ledger tables, and
-- nothing else. No UPDATE, no DELETE, no TRUNCATE, and no ownership, so the
-- service holding these credentials cannot rewrite history and cannot disable
-- the append-only triggers either. Probed on pgvector/pgvector:pg16: each of
-- the three answers `permission denied`.
--
-- NOLOGIN here. A deployment logs in as this role, or as a login role granted
-- it, with a credential its secret store issues; `yarn ledger:migrate` sets a
-- password only when LEDGER_WRITER_PASSWORD is given, which is the local and
-- test path. Idempotent: applied after every migration.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_writer') THEN
		CREATE ROLE ledger_writer NOLOGIN;
	END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ledger_writer;
REVOKE ALL ON ledger_entries, ledger_payloads, ledger_anchors FROM ledger_writer;
GRANT SELECT, INSERT ON ledger_entries, ledger_payloads, ledger_anchors TO ledger_writer;
