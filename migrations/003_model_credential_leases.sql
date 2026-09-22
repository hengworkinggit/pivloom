-- References accepted by the server retain only the exact encrypted version they use.
-- No plaintext secret is copied into a task/run record.
CREATE TABLE nano.model_credential_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  config_version integer NOT NULL,
  reference_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  released_at timestamptz(3),
  UNIQUE(owner_id, reference_id),
  FOREIGN KEY(profile_id, config_version, owner_id)
    REFERENCES nano.model_profile_versions(profile_id, config_version, owner_id)
);
CREATE INDEX active_model_credential_leases
  ON nano.model_credential_leases(owner_id, profile_id, config_version)
  WHERE released_at IS NULL;
ALTER TABLE nano.model_credential_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.model_credential_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.model_credential_leases TO nano_api
  USING (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
REVOKE ALL ON nano.model_credential_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON nano.model_credential_leases TO nano_api;
GRANT DELETE ON nano.model_credentials TO nano_api;
