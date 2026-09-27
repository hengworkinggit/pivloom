-- A project-card image belongs to an immutable source revision, independent
-- of Reviewer evidence and the lifetime of a Preview sandbox.
CREATE TABLE nano.revision_covers (
  revision_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  png bytea NOT NULL CHECK (octet_length(png) BETWEEN 8 AND 2097152),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY (revision_id,project_id,owner_id)
    REFERENCES nano.revisions(id,project_id,owner_id) ON DELETE CASCADE
);
ALTER TABLE nano.revision_covers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.revision_covers FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.revision_covers TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
REVOKE ALL ON nano.revision_covers FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON nano.revision_covers TO nano_api;
