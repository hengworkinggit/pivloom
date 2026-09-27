-- Published application data belongs to the project, not a source revision or
-- a short-lived Preview sandbox. The first supported collections are the two
-- templates that accept submissions from visitors.
CREATE TABLE nano.app_data_profiles (
  project_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('event-signup','appointments')),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE(project_id,owner_id),
  FOREIGN KEY(project_id,owner_id) REFERENCES nano.projects(id,owner_id)
);

-- Existing template projects remain distinguishable, but their old source
-- still uses localStorage; publication eligibility checks the source contract.
INSERT INTO nano.app_data_profiles(project_id,owner_id,kind)
SELECT i.project_id,i.owner_id,i.slug FROM nano.template_imports i
WHERE i.slug IN ('event-signup','appointments');

CREATE TABLE nano.app_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  collection text NOT NULL CHECK (collection IN ('registrations','bookings')),
  idempotency_key uuid NOT NULL,
  unique_key text NOT NULL CHECK (char_length(unique_key) BETWEEN 1 AND 300),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=4096),
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,owner_id) REFERENCES nano.app_data_profiles(project_id,owner_id),
  UNIQUE(project_id,collection,idempotency_key),
  UNIQUE(project_id,collection,unique_key)
);
CREATE INDEX app_records_latest ON nano.app_records(project_id,collection,created_at DESC,id DESC);

ALTER TABLE nano.app_data_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.app_data_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.app_data_profiles TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
ALTER TABLE nano.app_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.app_records FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.app_records TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
REVOKE ALL ON nano.app_data_profiles,nano.app_records FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON nano.app_data_profiles TO nano_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON nano.app_records TO nano_api;

-- The public HTTP handler first verifies the published hostname. This narrow
-- lookup then yields the owner needed for the existing owner-scoped DB adapter;
-- the function itself exposes no records and is never an HTTP endpoint.
CREATE FUNCTION nano.app_data_profile(p_project uuid)
RETURNS TABLE(o_owner_id uuid,o_kind text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  SELECT owner_id,kind FROM nano.app_data_profiles WHERE project_id=p_project;
$$;
REVOKE ALL ON FUNCTION nano.app_data_profile(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION nano.app_data_profile(uuid) TO nano_api;
