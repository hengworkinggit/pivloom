-- 026: give run_failures the ownership and privileges every other nano table carries.
--
-- 025 created the table with only the run id. Two things were wrong with that. The runtime role
-- nano_api was never granted anything on it, so reading a failed run's cause raised a permission
-- error and the run detail endpoint answered 500; and nothing tied a row to its owner, which is the
-- isolation every other table in this schema enforces through RLS.
--
-- This adds the owner column and applies the same policy and grants as migration 002. The table is
-- empty in every environment, because writes were impossible without the grant added below; the
-- delete is a guard for a database where an administrator inserted a row by hand, and it keeps the
-- NOT NULL from failing there.
ALTER TABLE nano.run_failures ADD COLUMN IF NOT EXISTS owner_id uuid;
DELETE FROM nano.run_failures WHERE owner_id IS NULL;
ALTER TABLE nano.run_failures ALTER COLUMN owner_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE nano.run_failures ENABLE ROW LEVEL SECURITY;
  ALTER TABLE nano.run_failures FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS owner_only ON nano.run_failures;
  CREATE POLICY owner_only ON nano.run_failures TO nano_api
    USING (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)
    WITH CHECK (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
  REVOKE ALL ON nano.run_failures FROM PUBLIC, anon, authenticated;
  GRANT SELECT, INSERT, UPDATE ON nano.run_failures TO nano_api;
END $$;
