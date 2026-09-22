CREATE SCHEMA IF NOT EXISTS nano;
REVOKE ALL ON SCHEMA nano FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nano_api') THEN
    CREATE ROLE nano_api NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT nano_api TO %I', current_user);
END $$;

CREATE TABLE nano.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  current_revision_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_updated ON nano.projects(owner_id, updated_at DESC, id DESC);
ALTER TABLE nano.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_owner ON nano.projects TO nano_api
  USING (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
REVOKE ALL ON ALL TABLES IN SCHEMA nano FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA nano TO nano_api;
GRANT SELECT, INSERT ON nano.projects TO nano_api;
