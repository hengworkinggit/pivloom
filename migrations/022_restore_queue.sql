-- 022: let a preview restore wait for capacity instead of being refused.
--
-- Issue #29 requires generation, increments, retries, preview restore and
-- rollback to share one scheduler and one capacity ledger. Generation already
-- queues; restore used to reject with SERVICE_BUSY when the ceiling was full, so
-- the request was never stored and nothing started it later.
--
-- A restore that cannot get a slot is now persisted as 'queued'. It keeps its
-- project operation lock, because it is the project's current operation and the
-- user is waiting for its result; what it does not hold is a capacity slot. The
-- scheduler claims it with nano.claim_next_queued_restore, which reserves a slot
-- and moves the row to 'pending' in one transaction, and the existing executor
-- path consumes 'pending' exactly as before.

ALTER TABLE nano.preview_restores DROP CONSTRAINT preview_restores_status_check;
ALTER TABLE nano.preview_restores ADD CONSTRAINT preview_restores_status_check
  CHECK (status IN ('queued','pending','ready','failed'));

-- The old index only covered 'pending'; a queued request and an in-flight one
-- are both "this project already has a restore", so they share the index.
DROP INDEX nano.one_active_restore_per_project;
CREATE UNIQUE INDEX one_active_restore_per_project ON nano.preview_restores(project_id)
  WHERE status IN ('queued','pending');

-- Claims at most one waiting restore for the whole instance. Dispatch is
-- instance-wide because capacity is instance-wide; the caller does not choose
-- whose request runs next.
CREATE FUNCTION nano.claim_next_queued_restore(p_ceiling integer)
RETURNS SETOF nano.preview_restores
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE
  v_restore uuid;
  v_claimed uuid;
BEGIN
  IF NOT nano.reserve_generation_capacity(p_ceiling) THEN
    RETURN;
  END IF;
  SELECT r.id INTO v_restore
  FROM nano.preview_restores r
  JOIN nano.projects p ON p.id = r.project_id AND p.owner_id = r.owner_id
  WHERE r.status = 'queued' AND p.operation_id = r.id
  ORDER BY r.created_at, r.id
  LIMIT 1;
  IF v_restore IS NULL THEN
    RETURN;
  END IF;
  -- The slab reserved above is only kept if this row really changes state; an
  -- empty update means another claimer won and this transaction must not hold a
  -- slot it never used.
  UPDATE nano.preview_restores
  SET status = 'pending'
  WHERE id = v_restore AND status = 'queued'
  RETURNING id INTO v_claimed;
  IF v_claimed IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM nano.preview_restores WHERE id = v_restore;
END;
$$;

REVOKE ALL ON FUNCTION nano.claim_next_queued_restore(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.claim_next_queued_restore(integer) TO nano_api;
