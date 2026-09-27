ALTER TABLE nano.projects ADD COLUMN archived_at timestamptz(3);
CREATE INDEX projects_owner_archive_recent ON nano.projects(owner_id, archived_at, updated_at DESC, id DESC);

-- Called only after the API has authenticated the owner and stopped serving a
-- published release. Every row removal is one transaction; a failed FK check
-- restores the whole project. Storage objects remain private and inaccessible.
CREATE FUNCTION nano.delete_owned_project(p_project uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = nano, pg_catalog
SET row_security = off
AS $$
DECLARE
  v_owner uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_operation text;
  v_run_ids uuid[];
BEGIN
  IF v_owner IS NULL THEN RETURN false; END IF;
  SELECT operation_kind INTO v_operation FROM nano.projects
    WHERE owner_id=v_owner AND id=p_project FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_operation IS NOT NULL OR EXISTS (
    SELECT 1 FROM nano.runs WHERE owner_id=v_owner AND project_id=p_project
      AND (state IN ('queued','accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
        OR cleanup_state='pending')
  ) OR EXISTS (
    SELECT 1 FROM nano.sandboxes WHERE owner_id=v_owner AND project_id=p_project
      AND state NOT IN ('destroyed','expired')
  ) THEN RAISE EXCEPTION 'PROJECT_BUSY' USING ERRCODE='P0001'; END IF;

  SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO v_run_ids FROM nano.runs
    WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.app_records WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.app_private_state WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.app_data_profiles WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.template_imports WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.messages WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.checks WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.review_continuations WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.run_events WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.verification_programs WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.preview_restores WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.rollbacks WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.sandboxes WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.revisions WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.role_runs WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.runs WHERE owner_id=v_owner AND project_id=p_project;
  DELETE FROM nano.model_credential_leases WHERE owner_id=v_owner AND reference_id=ANY(v_run_ids);
  DELETE FROM nano.projects WHERE owner_id=v_owner AND id=p_project;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION nano.delete_owned_project(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION nano.delete_owned_project(uuid) TO nano_api;
