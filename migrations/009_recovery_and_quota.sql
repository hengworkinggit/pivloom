-- DEV-09 / DEV-11: service-restart recovery and per-account daily quota.
--
-- Recovery has to look at every owner, but the API only ever connects as the
-- non-admin `nano_api` role with row level security forced to one owner. These
-- functions are SECURITY DEFINER and owned by `postgres` (BYPASSRLS) so the
-- boot scan can claim stale runs atomically without handing the API process a
-- privileged connection string.
--
-- Output parameters are prefixed because a PL/pgSQL OUT parameter whose name
-- matches a column used in the body is rejected at runtime.

-- The return type changed while this migration was being written, so the old
-- signature is dropped explicitly; CREATE OR REPLACE cannot change it.
DROP FUNCTION IF EXISTS nano.claim_stale_runs(uuid);

CREATE OR REPLACE FUNCTION nano.claim_stale_runs(p_boot uuid)
RETURNS TABLE(o_run_id uuid, o_owner_id uuid, o_project_id uuid, o_sandbox_ids text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH stale AS (
    -- A run left in cleanup_state='pending' by an earlier crash still holds the
    -- global slot, so the next boot has to reclaim it even though its state is
    -- already terminal. Only rows this process did not create are eligible.
    SELECT r.id AS stale_run_id,
      (r.state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')) AS was_active
    FROM nano.runs r
    WHERE (r.state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
        OR r.cleanup_state = 'pending')
      AND r.executor_boot_id <> p_boot
    FOR UPDATE
  ), marked AS (
    UPDATE nano.runs r
    SET state = CASE WHEN s.was_active THEN 'interrupted' ELSE r.state END,
        phase = CASE WHEN s.was_active THEN 'cleanup' ELSE r.phase END,
        cleanup_state = 'pending',
        error_code = CASE WHEN s.was_active THEN 'SERVICE_RESTARTED' ELSE r.error_code END,
        error_message = CASE WHEN s.was_active THEN '服务重启中断了本次执行，已保存的内容保留，可以重新提交。' ELSE r.error_message END,
        error_retryable = CASE WHEN s.was_active THEN true ELSE r.error_retryable END,
        finished_at = CASE WHEN s.was_active THEN now() ELSE r.finished_at END
    FROM stale s
    WHERE r.id = s.stale_run_id
    RETURNING r.id AS marked_run_id, r.owner_id AS marked_owner, r.project_id AS marked_project,
      r.attempt AS marked_attempt, s.was_active AS marked_was_active
  ), touched_roles AS (
    UPDATE nano.role_runs rr
    SET state = 'interrupted', finished_at = coalesce(rr.finished_at, now())
    FROM marked m
    WHERE rr.run_id = m.marked_run_id AND rr.state IN ('queued','running')
    RETURNING rr.id AS touched_role_id
  ), logged AS (
    INSERT INTO nano.run_events (owner_id, project_id, run_id, role_run_id, attempt, type, payload_json)
    SELECT m.marked_owner, m.marked_project, m.marked_run_id, NULL, m.marked_attempt, 'run.finished',
      jsonb_build_object('state','interrupted','reason','SERVICE_RESTARTED')
    FROM marked m
    WHERE m.marked_was_active
    RETURNING run_id
  )
  SELECT m.marked_run_id, m.marked_owner, m.marked_project,
    coalesce((SELECT array_agg(s.remote_id ORDER BY s.created_at)
      FROM nano.sandboxes s
      WHERE s.owner_id = m.marked_owner AND s.run_id = m.marked_run_id AND s.state IN ('creating','active')), ARRAY[]::text[])
  FROM marked m;
END $$;

-- Called once the remote sandboxes of a recovered run are confirmed gone.
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

REVOKE ALL ON FUNCTION nano.claim_stale_runs(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION nano.settle_recovered_run(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.claim_stale_runs(uuid) TO nano_api;
GRANT EXECUTE ON FUNCTION nano.settle_recovered_run(uuid, uuid) TO nano_api;

-- The daily quota counts one owner's accepted runs in a rolling day window.
CREATE INDEX IF NOT EXISTS runs_owner_created ON nano.runs(owner_id, created_at DESC);
