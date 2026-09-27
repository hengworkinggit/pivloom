-- Curated starter projects have real source and builds, but do not use a model.
ALTER TABLE nano.runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE nano.runs ADD CONSTRAINT runs_kind_check
  CHECK (kind IN ('generate','modify','retry','clarify','template'));

ALTER TABLE nano.runs
  ALTER COLUMN model_profile_id DROP NOT NULL,
  ALTER COLUMN model_config_version DROP NOT NULL,
  ALTER COLUMN credential_lease_id DROP NOT NULL,
  ADD COLUMN template_slug text;

ALTER TABLE nano.runs ADD CONSTRAINT template_model_provenance CHECK (
  (kind = 'template' AND template_slug IS NOT NULL AND char_length(template_slug) BETWEEN 1 AND 80
    AND model_profile_id IS NULL AND model_config_version IS NULL
    AND model_id IS NULL AND credential_lease_id IS NULL)
  OR (kind <> 'template' AND model_profile_id IS NOT NULL
    AND model_config_version IS NOT NULL AND credential_lease_id IS NOT NULL AND template_slug IS NULL)
);

ALTER TABLE nano.revisions ADD COLUMN template_slug text;

CREATE TABLE nano.template_imports (
  owner_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  slug text NOT NULL,
  project_id uuid NOT NULL,
  PRIMARY KEY(owner_id,idempotency_key),
  UNIQUE(project_id),
  FOREIGN KEY(project_id,owner_id) REFERENCES nano.projects(id,owner_id)
);
ALTER TABLE nano.template_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.template_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.template_imports TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
REVOKE ALL ON nano.template_imports FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON nano.template_imports TO nano_api;
