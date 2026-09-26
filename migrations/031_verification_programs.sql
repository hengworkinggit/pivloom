-- A saved program belongs to one owner/project requirement. Later revisions may
-- reuse it, but runtime callers cannot update or delete its original criteria.
CREATE TABLE nano.verification_programs (
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  behavior_id text NOT NULL CHECK(behavior_id ~ '^B(0[1-9]|[1-9][0-9])$'),
  requirement_hash char(64) NOT NULL CHECK(requirement_hash ~ '^[a-f0-9]{64}$'),
  program_json jsonb NOT NULL CHECK(jsonb_typeof(program_json)='object' AND octet_length(program_json::text)<=1048576),
  program_hash char(64) NOT NULL CHECK(program_hash ~ '^[a-f0-9]{64}$'),
  run_id uuid NOT NULL,
  role_run_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,project_id,behavior_id,requirement_hash),
  FOREIGN KEY(project_id,owner_id) REFERENCES nano.projects(id,owner_id),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id),
  FOREIGN KEY(role_run_id,run_id,owner_id) REFERENCES nano.role_runs(id,run_id,owner_id),
  FOREIGN KEY(revision_id,project_id,owner_id) REFERENCES nano.revisions(id,project_id,owner_id)
);
ALTER TABLE nano.verification_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.verification_programs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.verification_programs TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
REVOKE ALL ON nano.verification_programs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON nano.verification_programs TO nano_api;
