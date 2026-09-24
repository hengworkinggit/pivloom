-- 024: let a waiting queue reclaim an idle preview so it can advance.
--
-- Requirement 6 of #29: with waiters present the queue must be able to move
-- without waiting for a preview lease to lapse on its own. Until now the only
-- thing that ever released a preview slot was time, so two retained previews
-- could hold the ceiling for the rest of their lease while a queued task waited.
--
-- Reclaim does not delete anything the user depends on. Source, revision,
-- versions, checks and the last saved screenshot are all stored independently of
-- the sandbox; only the sandbox goes away, and the preview then reports the same
-- "expired, restart it" state the workbench already handles. Restarting it goes
-- through the restore queue added by migration 022, so the resources used to
-- rebuild are accounted for like every other operation.
--
-- Safety comes from what the candidate query excludes, not from the caller:
--   * a preview whose project holds an operation (a run, a restore, a rollback
--     or a publish in progress) is never eligible, which is what keeps in-flight
--     builds, rollback preparation and publication reads from being reclaimed;
--   * a preview belonging to a run that is not finished is never eligible;
--   * a sandbox whose lease has already lapsed is left to the executor's own
--     expiry sweep rather than being counted here.
CREATE OR REPLACE FUNCTION nano.preview_reclaim_candidates()
RETURNS TABLE(sandbox_id text, owner_id uuid, project_id uuid, revision_id uuid, run_id uuid, superseded boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  SELECT s.remote_id, s.owner_id, s.project_id, s.revision_id, s.run_id,
    (p.current_revision_id IS DISTINCT FROM s.revision_id) AS superseded
  FROM nano.sandboxes s
  JOIN nano.projects p ON p.id = s.project_id AND p.owner_id = s.owner_id
  JOIN nano.runs r ON r.id = s.run_id AND r.owner_id = s.owner_id
  WHERE s.state = 'active'
    AND s.expires_at > now()
    AND s.purpose IN ('candidate-preview','preview')
    AND p.operation_id IS NULL
    AND r.state NOT IN ('queued','accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
    AND r.cleanup_state <> 'pending'
  -- Prefer a preview the user has already moved past, then the oldest one, so a
  -- reclaim costs the least visible state and is deterministic.
  ORDER BY (p.current_revision_id IS DISTINCT FROM s.revision_id) DESC, s.expires_at, s.remote_id;
$$;

REVOKE ALL ON FUNCTION nano.preview_reclaim_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.preview_reclaim_candidates() TO nano_api;
