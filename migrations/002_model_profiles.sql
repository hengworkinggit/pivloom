CREATE TABLE nano.model_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  current_version integer NOT NULL CHECK(current_version > 0),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  deleted_at timestamptz(3),
  UNIQUE(id, owner_id)
);
CREATE UNIQUE INDEX one_default_model_per_owner ON nano.model_profiles(owner_id)
  WHERE is_default AND deleted_at IS NULL;

CREATE TABLE nano.model_profile_versions (
  profile_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  config_version integer NOT NULL CHECK(config_version > 0),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
  provider text NOT NULL CHECK(provider IN ('openai-completions', 'anthropic-messages')),
  base_url text NOT NULL,
  model_id text NOT NULL CHECK(char_length(model_id) BETWEEN 1 AND 160),
  key_mask text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{"streaming":"unknown","tools":"unknown","vision":"unknown"}',
  last_test jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(profile_id, config_version),
  UNIQUE(profile_id, config_version, owner_id),
  FOREIGN KEY(profile_id, owner_id) REFERENCES nano.model_profiles(id, owner_id)
);
ALTER TABLE nano.model_profiles ADD CONSTRAINT current_model_version_exists
  FOREIGN KEY(id, current_version, owner_id)
  REFERENCES nano.model_profile_versions(profile_id, config_version, owner_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE nano.model_credentials (
  profile_id uuid NOT NULL,
  config_version integer NOT NULL,
  owner_id uuid NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag) = 16),
  PRIMARY KEY(profile_id, config_version),
  FOREIGN KEY(profile_id, config_version, owner_id)
    REFERENCES nano.model_profile_versions(profile_id, config_version, owner_id)
);

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['model_profiles','model_profile_versions','model_credentials'] LOOP
    EXECUTE format('ALTER TABLE nano.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE nano.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY owner_only ON nano.%I TO nano_api USING (owner_id = nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid)', relation);
    EXECUTE format('REVOKE ALL ON nano.%I FROM PUBLIC, anon, authenticated', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON nano.%I TO nano_api', relation);
  END LOOP;
END $$;
