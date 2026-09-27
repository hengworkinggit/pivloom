-- Final Checks remain unique per candidate. Intermediate verified receipts stay
-- private and owner-scoped, with the original role/session binding intact.
CREATE TABLE nano.review_continuations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  role_run_id uuid NOT NULL UNIQUE,
  attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  revision_id uuid NOT NULL,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=5242880),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id),
  FOREIGN KEY(role_run_id,run_id,owner_id) REFERENCES nano.role_runs(id,run_id,owner_id) ON DELETE CASCADE,
  FOREIGN KEY(revision_id,project_id,owner_id) REFERENCES nano.revisions(id,project_id,owner_id)
);
CREATE INDEX review_continuations_candidate ON nano.review_continuations(owner_id,run_id,attempt,revision_id,source_hash);
ALTER TABLE nano.review_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.review_continuations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.review_continuations TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
REVOKE ALL ON nano.review_continuations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON nano.review_continuations TO nano_api;
ALTER TABLE nano.checks ADD COLUMN item_provenance_json jsonb
  CHECK(item_provenance_json IS NULL OR (jsonb_typeof(item_provenance_json)='array' AND octet_length(item_provenance_json::text)<=65536));
