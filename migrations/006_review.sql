ALTER TABLE nano.runs
  ADD COLUMN reviewer_role_run_id uuid,
  ADD CONSTRAINT run_reviewer_role FOREIGN KEY(reviewer_role_run_id,id,owner_id)
    REFERENCES nano.role_runs(id,run_id,owner_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nano.role_runs
  ADD COLUMN review_binding_json jsonb CHECK(review_binding_json IS NULL OR
    (role='reviewer' AND jsonb_typeof(review_binding_json)='object' AND octet_length(review_binding_json::text)<=4096));

CREATE TABLE nano.checks (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  role_run_id uuid NOT NULL UNIQUE,
  attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  revision_id uuid NOT NULL UNIQUE,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  sandbox_id text NOT NULL,
  browser_session_id text NOT NULL UNIQUE,
  verdict text NOT NULL CHECK(verdict IN ('passed','failed','blocked')),
  items_json jsonb NOT NULL CHECK(jsonb_typeof(items_json)='array' AND octet_length(items_json::text)<=65536),
  artifacts_json jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(artifacts_json)='array' AND octet_length(artifacts_json::text)<=16384),
  evidence_json jsonb NOT NULL CHECK(jsonb_typeof(evidence_json)='array' AND octet_length(evidence_json::text)<=524288),
  summary text NOT NULL CHECK(char_length(summary) BETWEEN 1 AND 4000),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id),
  FOREIGN KEY(role_run_id,run_id,owner_id) REFERENCES nano.role_runs(id,run_id,owner_id),
  FOREIGN KEY(revision_id,project_id,owner_id) REFERENCES nano.revisions(id,project_id,owner_id),
  UNIQUE(run_id,attempt)
);
CREATE INDEX checks_owner_run ON nano.checks(owner_id,run_id);
ALTER TABLE nano.checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.checks FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.checks TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
REVOKE ALL ON nano.checks FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON nano.checks TO nano_api;
