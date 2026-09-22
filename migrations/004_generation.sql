ALTER TABLE nano.projects
  ADD CONSTRAINT projects_id_owner UNIQUE(id, owner_id),
  ADD COLUMN next_revision_no integer NOT NULL DEFAULT 1 CHECK(next_revision_no > 0),
  ADD COLUMN operation_kind text CHECK(operation_kind IN ('generate','restore')),
  ADD COLUMN operation_id uuid,
  ADD COLUMN operation_started_at timestamptz(3),
  ADD CONSTRAINT project_operation_pair CHECK((operation_kind IS NULL) = (operation_id IS NULL));
GRANT UPDATE ON nano.projects TO nano_api;
ALTER TABLE nano.model_credential_leases ADD CONSTRAINT lease_exact_reference
  UNIQUE(id, reference_id, owner_id, profile_id, config_version);

CREATE TABLE nano.runs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  request_text text NOT NULL CHECK(char_length(request_text) BETWEEN 1 AND 8000),
  kind text NOT NULL CHECK(kind IN ('generate','modify','retry','clarify')),
  retry_of uuid,
  parent_run_id uuid,
  expected_current_revision_id uuid,
  base_revision_id uuid,
  result_revision_id uuid,
  model_profile_id uuid NOT NULL,
  model_config_version integer NOT NULL,
  credential_lease_id uuid NOT NULL UNIQUE,
  builder_role_run_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('accepted','planning','building','verifying','repairing','finalizing',
    'cancel_requested','completed','needs_changes','needs_input','failed','cancelled','interrupted')),
  phase text NOT NULL CHECK(phase IN ('plan','provision','implement','build','snapshot','review','persist','cleanup')),
  attempt smallint NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 2),
  cleanup_state text NOT NULL DEFAULT 'clear' CHECK(cleanup_state IN ('clear','pending','confirmed')),
  error_code text,
  error_message text,
  error_retryable boolean,
  summary text,
  budget_json jsonb NOT NULL,
  usage_json jsonb NOT NULL DEFAULT '{}',
  deadline_at timestamptz(3) NOT NULL,
  executor_boot_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  finished_at timestamptz(3),
  UNIQUE(project_id, idempotency_key),
  UNIQUE(id, project_id, owner_id),
  UNIQUE(id, owner_id),
  FOREIGN KEY(project_id, owner_id) REFERENCES nano.projects(id, owner_id),
  FOREIGN KEY(credential_lease_id,id,owner_id,model_profile_id,model_config_version)
    REFERENCES nano.model_credential_leases(id,reference_id,owner_id,profile_id,config_version)
);
CREATE UNIQUE INDEX one_active_run_per_project ON nano.runs(project_id)
  WHERE state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested');
-- The unique constraint is global even when owner RLS hides another user's run.
CREATE UNIQUE INDEX one_global_generation ON nano.runs((true))
  WHERE state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
    OR cleanup_state='pending';
CREATE INDEX project_runs_latest ON nano.runs(project_id, created_at DESC, id DESC);

CREATE TABLE nano.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('user','result','question')),
  content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 8000),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id),
  UNIQUE(run_id,kind)
);

CREATE TABLE nano.role_runs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  predecessor_id uuid,
  role text NOT NULL CHECK(role IN ('coordinator','builder','reviewer')),
  attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  session_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  input_json jsonb NOT NULL,
  output_json jsonb,
  usage_json jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz(3),
  finished_at timestamptz(3),
  UNIQUE(run_id,role,attempt),
  UNIQUE(id,run_id,owner_id),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id),
  FOREIGN KEY(predecessor_id,run_id,owner_id) REFERENCES nano.role_runs(id,run_id,owner_id)
);
ALTER TABLE nano.runs ADD CONSTRAINT run_builder_role
  FOREIGN KEY(builder_role_run_id,id,owner_id) REFERENCES nano.role_runs(id,run_id,owner_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE nano.revisions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK(revision_no > 0),
  attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  source_key text NOT NULL UNIQUE,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  template_version text NOT NULL,
  manifest_json jsonb NOT NULL,
  source_bytes integer NOT NULL CHECK(source_bytes BETWEEN 1 AND 5242880),
  compressed_bytes integer NOT NULL CHECK(compressed_bytes > 0),
  build_status text NOT NULL CHECK(build_status IN ('passed','failed')),
  build_json jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('candidate','accepted','rejected')),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE(id,project_id,owner_id),
  UNIQUE(project_id,revision_no),
  UNIQUE(run_id,attempt),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id)
);
ALTER TABLE nano.projects ADD CONSTRAINT project_current_revision
  FOREIGN KEY(current_revision_id,id,owner_id) REFERENCES nano.revisions(id,project_id,owner_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE nano.runs
  ADD CONSTRAINT run_base_revision FOREIGN KEY(base_revision_id,project_id,owner_id)
    REFERENCES nano.revisions(id,project_id,owner_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT run_expected_revision FOREIGN KEY(expected_current_revision_id,project_id,owner_id)
    REFERENCES nano.revisions(id,project_id,owner_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT run_result_revision FOREIGN KEY(result_revision_id,project_id,owner_id)
    REFERENCES nano.revisions(id,project_id,owner_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT run_retry_parent FOREIGN KEY(retry_of,project_id,owner_id)
    REFERENCES nano.runs(id,project_id,owner_id),
  ADD CONSTRAINT run_clarification_parent FOREIGN KEY(parent_run_id,project_id,owner_id)
    REFERENCES nano.runs(id,project_id,owner_id);

CREATE TABLE nano.run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  role_run_id uuid,
  attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  type text NOT NULL CHECK(type IN ('run.accepted','run.phase','role.started','role.completed','tool.started',
    'tool.output','tool.completed','revision.saved','preview.ready','check.completed','run.cancel_requested','run.finished')),
  payload_json jsonb NOT NULL CHECK(octet_length(payload_json::text) <= 32768),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id),
  FOREIGN KEY(role_run_id,run_id,owner_id) REFERENCES nano.role_runs(id,run_id,owner_id)
);
CREATE INDEX events_replay ON nano.run_events(run_id,id);

CREATE TABLE nano.sandboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt smallint NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  remote_id text NOT NULL UNIQUE,
  revision_id uuid,
  source_hash char(64),
  purpose text NOT NULL CHECK(purpose IN ('candidate','candidate-preview','preview')),
  state text NOT NULL CHECK(state IN ('creating','active','expired','destroying','destroyed','error')),
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  last_checked_at timestamptz(3),
  error_message text,
  UNIQUE(run_id,attempt),
  FOREIGN KEY(run_id,project_id,owner_id) REFERENCES nano.runs(id,project_id,owner_id),
  FOREIGN KEY(revision_id,project_id,owner_id) REFERENCES nano.revisions(id,project_id,owner_id)
);

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['runs','messages','role_runs','revisions','run_events','sandboxes'] LOOP
    EXECUTE format('ALTER TABLE nano.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE nano.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY owner_only ON nano.%I TO nano_api USING (owner_id = nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid)', relation);
    EXECUTE format('REVOKE ALL ON nano.%I FROM PUBLIC, anon, authenticated', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON nano.%I TO nano_api', relation);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE nano.run_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE nano.run_events_id_seq TO nano_api;
