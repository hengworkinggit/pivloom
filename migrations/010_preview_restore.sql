-- DEV-10: rebuilding a preview from a saved revision after its sandbox is gone.
--
-- A restore is not a run: it never calls a model and never creates a revision.
-- It still needs its own durable record so the project operation lock, the
-- idempotency key and a finished result survive a service restart.

CREATE TABLE nano.preview_restores (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','ready','failed')),
  sandbox_id text,
  error_code text,
  error_message text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  finished_at timestamptz(3),
  UNIQUE(project_id, idempotency_key),
  UNIQUE(id, project_id, owner_id),
  FOREIGN KEY(project_id, owner_id) REFERENCES nano.projects(id, owner_id),
  FOREIGN KEY(revision_id, project_id, owner_id) REFERENCES nano.revisions(id, project_id, owner_id)
);

-- One restore in flight per project, mirroring the generate/modify operation lock.
CREATE UNIQUE INDEX one_active_restore_per_project ON nano.preview_restores(project_id)
  WHERE status = 'pending';

ALTER TABLE nano.preview_restores ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.preview_restores FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.preview_restores TO nano_api
  USING (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
REVOKE ALL ON nano.preview_restores FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON nano.preview_restores TO nano_api;

-- Recovered runs settle through SECURITY DEFINER helpers, so they also need to
-- clear a restore that was left pending by the same restart.
CREATE OR REPLACE FUNCTION nano.settle_recovered_run(p_owner uuid, p_run uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE v_project uuid;
BEGIN
  UPDATE nano.runs
  SET cleanup_state = 'confirmed'
  WHERE owner_id = p_owner AND id = p_run AND cleanup_state = 'pending'
  RETURNING project_id INTO v_project;
  IF v_project IS NULL THEN
    RETURN;
  END IF;
  UPDATE nano.sandboxes
  SET state = 'destroyed', last_checked_at = now()
  WHERE owner_id = p_owner AND run_id = p_run AND state IN ('creating','active','destroying');
  UPDATE nano.projects
  SET operation_kind = NULL, operation_id = NULL, operation_started_at = NULL, updated_at = now()
  WHERE owner_id = p_owner AND id = v_project AND operation_id = p_run;
END $$;

-- A restore only exists inside this process. Any row still pending at boot was
-- owned by a previous process, so it can never finish and must not keep the
-- project locked or leave the UI claiming a restore is still running.
CREATE OR REPLACE FUNCTION nano.recover_stale_restores()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE v_count integer;
BEGIN
  WITH dead AS (
    UPDATE nano.preview_restores
    SET status = 'failed',
        error_code = 'SERVICE_RESTARTED',
        error_message = '服务重启中断了本次预览恢复，可以重新发起。',
        finished_at = now()
    WHERE status = 'pending'
    RETURNING id, owner_id, project_id
  ), released AS (
    UPDATE nano.projects p
    SET operation_kind = NULL, operation_id = NULL, operation_started_at = NULL, updated_at = now()
    FROM dead d
    WHERE p.owner_id = d.owner_id AND p.id = d.project_id AND p.operation_id = d.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM dead;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION nano.recover_stale_restores() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.recover_stale_restores() TO nano_api;
