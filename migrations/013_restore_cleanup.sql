-- A pending preview restore retains its operation lock until its own remote
-- sandbox is confirmed gone. Never change the completed source Run or another
-- preview belonging to the same revision while reconciling this operation.
CREATE OR REPLACE FUNCTION nano.claim_stale_restores()
RETURNS TABLE(o_restore_id uuid, o_owner_id uuid, o_project_id uuid, o_sandbox_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  UPDATE nano.preview_restores r
  SET error_code = coalesce(r.error_code, 'SERVICE_RESTARTED'),
      error_message = coalesce(r.error_message, '服务重启中断了预览恢复，正在确认远端清理。')
  WHERE r.status = 'pending' AND r.sandbox_id IS NOT NULL
  RETURNING r.id, r.owner_id, r.project_id, r.sandbox_id;
END $$;

CREATE OR REPLACE FUNCTION nano.recover_stale_restores()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE v_count integer;
BEGIN
  WITH dead AS (
    UPDATE nano.preview_restores r
    SET status = 'failed',
        error_code = coalesce(r.error_code, 'SERVICE_RESTARTED'),
        error_message = coalesce(r.error_message, '服务重启中断了本次预览恢复，可以重新发起。'),
        finished_at = now()
    WHERE r.status = 'pending' AND (r.sandbox_id IS NULL OR EXISTS (
      SELECT 1 FROM nano.sandboxes s WHERE s.owner_id=r.owner_id AND s.project_id=r.project_id
        AND s.revision_id=r.revision_id AND s.remote_id=r.sandbox_id AND s.purpose='preview'
        AND s.state IN ('destroyed','expired')
    ))
    RETURNING r.id, r.owner_id, r.project_id
  ), released AS (
    UPDATE nano.projects p
    SET operation_kind=NULL, operation_id=NULL, operation_started_at=NULL, updated_at=now()
    FROM dead d WHERE p.owner_id=d.owner_id AND p.id=d.project_id AND p.operation_id=d.id
    RETURNING p.id
  ) SELECT count(*) INTO v_count FROM dead;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION nano.claim_stale_restores() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.claim_stale_restores() TO nano_api;
REVOKE ALL ON FUNCTION nano.recover_stale_restores() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.recover_stale_restores() TO nano_api;
