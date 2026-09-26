-- 027: the stored evidence ceiling must not be tighter than the reviewer's.
--
-- The same evidence record was bounded by three independent numbers: the
-- reviewer admitted 2 MiB in-run (REVIEW_EVIDENCE_LIMIT_BYTES, budgets.ts), the
-- persistence layer rejected above a 512 KiB literal (data/generation.ts) and
-- this CHECK stopped at 512 KiB. A completed forty-four behaviour check could
-- therefore pass its own review and then be lost at save time, which is exactly
-- the failure shape the capacity model exists to remove.
--
-- The app-side bound is now derived from one named source:
-- REVIEW_EVIDENCE_PERSISTENCE_LIMIT_BYTES (runtime/capacity.ts) = the
-- reviewer's REVIEW_EVIDENCE_LIMIT_BYTES plus the bytes of the persistence
-- payload's own object wrapper. This CHECK stays as the storage backstop.
--
-- The backstop has to accept everything that bound admits. PostgreSQL renders
-- jsonb as text with one space after each separator, so jsonb::text can never be
-- more than twice the compact JSON the application serialized (there is at most
-- one separator per input byte). 4 MiB is therefore the smallest round ceiling
-- that provably cannot reject an evidence array the application accepted, and
-- it remains a hard bound rather than a removed guard. The previous 512 KiB here
-- was one of the independent constants this change exists to reconcile.
ALTER TABLE nano.checks
  DROP CONSTRAINT checks_evidence_json_check,
  ADD CONSTRAINT checks_evidence_json_check CHECK (
    jsonb_typeof(evidence_json) = 'array'
    AND octet_length(evidence_json::text) <= 4194304
  );
