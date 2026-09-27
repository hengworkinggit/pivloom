-- Personal template data belongs to the Pivloom project owner. Visitors may
-- load the static page but cannot read or change its server-side state.
ALTER TABLE nano.app_data_profiles DROP CONSTRAINT app_data_profiles_kind_check;
ALTER TABLE nano.app_data_profiles ADD CONSTRAINT app_data_profiles_kind_check
  CHECK (kind IN ('event-signup','appointments','reading-list','task-board'));

INSERT INTO nano.app_data_profiles(project_id,owner_id,kind)
SELECT i.project_id,i.owner_id,i.slug FROM nano.template_imports i
WHERE i.slug IN ('reading-list','task-board')
ON CONFLICT (project_id) DO NOTHING;

CREATE TABLE nano.app_private_state (
  project_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reading-list','task-board')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  value_json jsonb NOT NULL CHECK (jsonb_typeof(value_json)='array' AND octet_length(value_json::text)<=65536),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,owner_id) REFERENCES nano.app_data_profiles(project_id,owner_id)
);
ALTER TABLE nano.app_private_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.app_private_state FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.app_private_state TO nano_api
  USING(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)
  WITH CHECK(owner_id = nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
REVOKE ALL ON nano.app_private_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON nano.app_private_state TO nano_api;
