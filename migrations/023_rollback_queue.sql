-- 023: let a rollback wait for capacity instead of being refused.
--
-- Same rule as 022 for preview restore: a rollback rebuilds the target revision
-- in its own sandbox, so it draws on the shared capacity ledger. Refusing it
-- with SERVICE_BUSY left the request unstored and nothing started it later,
-- which issue #29 forbids for every sandbox-creating operation.
--
-- A rollback that cannot get a slot is persisted as 'queued'. It already holds
-- the project operation lock; it does not hold a capacity slot until
-- nano.claim_next_queued_rollback reserves one and moves it to 'preparing',
-- which is the state the existing executor consumes.

ALTER TABLE nano.rollbacks DROP CONSTRAINT rollbacks_status_check;
ALTER TABLE nano.rollbacks ADD CONSTRAINT rollbacks_status_check CHECK (status IN
  ('queued','preparing','prepared','committed','failed','cancel_requested','cleanup_pending','cancelled'));

-- The operation lock index has to treat a waiting rollback as an active one, or
-- a second rollback could be admitted for the same project while the first waits.
DROP INDEX nano.one_active_rollback_per_project;
CREATE UNIQUE INDEX one_active_rollback_per_project ON nano.rollbacks(project_id)
  WHERE status IN ('queued','preparing','prepared','cancel_requested','cleanup_pending');

CREATE OR REPLACE FUNCTION nano.claim_next_queued_rollback(p_ceiling integer)
RETURNS SETOF nano.rollbacks
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE
  v_rollback uuid;
  v_claimed uuid;
BEGIN
  IF NOT nano.reserve_generation_capacity(p_ceiling) THEN
    RETURN;
  END IF;
  SELECT r.id INTO v_rollback
  FROM nano.rollbacks r
  JOIN nano.projects p ON p.id = r.project_id AND p.owner_id = r.owner_id
  WHERE r.status = 'queued' AND p.operation_id = r.id
  ORDER BY r.created_at, r.id
  LIMIT 1;
  IF v_rollback IS NULL THEN
    RETURN;
  END IF;
  -- The slot reserved above is kept only if this row really changes state.
  UPDATE nano.rollbacks
  SET status = 'preparing'
  WHERE id = v_rollback AND status = 'queued'
  RETURNING id INTO v_claimed;
  IF v_claimed IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM nano.rollbacks WHERE id = v_rollback;
END;
$$;

REVOKE ALL ON FUNCTION nano.claim_next_queued_rollback(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.claim_next_queued_rollback(integer) TO nano_api;

-- Also carries the dispatch ordering fix for generation runs, because migration
-- 021 is already applied in production and the tool refuses a changed file.
--
-- 021 sorted dispatch by the reported position. Two rows can share a position
-- while their keys differ, and ordering by a tied value hands the choice to
-- physical row order: a task that had already been served could be picked ahead
-- of an account that was waiting, which is the starvation this queue exists to
-- prevent. Dispatch now orders by the same key that produces the rank, written
-- the same way so the two cannot disagree.
CREATE OR REPLACE FUNCTION nano.claim_next_queued_run(p_boot uuid, p_ceiling integer, p_run uuid DEFAULT NULL, p_owner uuid DEFAULT NULL)
RETURNS SETOF nano.runs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE
  v_run uuid;
  v_project uuid;
  v_claimed uuid;
BEGIN
  IF p_boot IS NULL THEN
    RAISE EXCEPTION 'claim requires an executor boot id';
  END IF;
  IF NOT nano.reserve_generation_capacity(p_ceiling) THEN
    RETURN;
  END IF;
  SELECT c.run_id INTO v_run
  FROM nano.queue_candidates() c
  JOIN nano.runs r ON r.id = c.run_id
  WHERE NOT c.blocked
    AND (p_run IS NULL OR c.run_id = p_run)
    AND (p_owner IS NULL OR c.owner_id = p_owner)
  ORDER BY c.last_dispatch ASC NULLS FIRST, r.created_at ASC, c.run_id ASC
  LIMIT 1;
  IF v_run IS NULL THEN
    RETURN;
  END IF;
  -- Project first (matching nano.lockedRun's order), then the run it owns.
  SELECT r.project_id INTO v_project
  FROM nano.runs r
  WHERE r.id = v_run AND r.state = 'queued';
  IF v_project IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1 FROM nano.projects p
  WHERE p.id = v_project AND p.operation_id IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE nano.projects
  SET operation_kind = 'generate', operation_id = v_run, operation_started_at = now(), updated_at = now()
  WHERE id = v_project AND operation_id IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE nano.runs
  SET state = 'accepted', phase = 'plan', dispatched_at = now(), executor_boot_id = p_boot,
    deadline_at = now() + make_interval(secs => coalesce((budget_json->>'idleTimeoutMs')::numeric / 1000, 600))
  WHERE id = v_run AND state = 'queued'
  RETURNING id INTO v_claimed;
  IF v_claimed IS NULL THEN
    RAISE EXCEPTION 'claimed run left the queue before dispatch';
  END IF;
  INSERT INTO nano.run_events (owner_id, project_id, run_id, role_run_id, attempt, type, payload_json)
  SELECT r.owner_id, r.project_id, r.id, NULL, r.attempt, 'run.accepted',
    jsonb_build_object('state','accepted','phase','plan','dispatched',true)
  FROM nano.runs r WHERE r.id = v_run;
  RETURN QUERY SELECT * FROM nano.runs WHERE id = v_run;
END;
$$;

-- Admission for a rollback and the capacity count it draws on.
--
-- The reservation a caller takes only lives inside its own transaction, so
-- "reserve here, create the sandbox later" would leave a window in which
-- another operation also sees a free slot. Inside this function the reservation
-- and the row that represents the work commit together: the row is either
-- 'preparing' (it holds the slot, and the counter below counts it until its
-- sandbox is registered) or 'queued' (it holds nothing).
CREATE FUNCTION nano.reserve_rollback_slot(p_owner uuid, p_project uuid, p_from uuid, p_target uuid,
  p_source_hash char(64), p_idempotency uuid, p_ceiling integer)
RETURNS nano.rollbacks
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE
  v_admitted boolean;
  v_row nano.rollbacks;
BEGIN
  -- Same lock the capacity counter uses, so admission is serialised against
  -- every other claim instead of racing it.
  PERFORM pg_advisory_xact_lock(423194820751::bigint);
  v_admitted := nano.reserve_generation_capacity(p_ceiling);
  INSERT INTO nano.rollbacks (id,owner_id,project_id,from_revision_id,target_revision_id,source_hash,idempotency_key,status)
  VALUES (gen_random_uuid(),p_owner,p_project,p_from,p_target,p_source_hash,p_idempotency,
    CASE WHEN v_admitted THEN 'preparing' ELSE 'queued' END)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- The same count as nano.reserve_generation_capacity, plus the work that already
-- holds a slot but has not registered its sandbox yet. Without those two terms a
-- rollback or restore that was just admitted would look like free capacity.
CREATE OR REPLACE FUNCTION nano.generation_capacity_occupied()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  SELECT (
    (SELECT count(*) FROM nano.sandboxes s
      WHERE s.state IN ('creating','active') AND s.expires_at > now())
    + (SELECT count(*) FROM nano.runs r
        WHERE (r.state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
          OR r.cleanup_state = 'pending')
          AND NOT EXISTS (SELECT 1 FROM nano.sandboxes s WHERE s.run_id = r.id
            AND s.state IN ('creating','active') AND s.expires_at > now()))
    + (SELECT count(*) FROM nano.rollbacks b
        WHERE b.status IN ('preparing','prepared') AND b.sandbox_id IS NULL)
    + (SELECT count(*) FROM nano.preview_restores r
        WHERE r.status = 'pending' AND r.sandbox_id IS NULL)
  )::integer;
$$;

REVOKE ALL ON FUNCTION nano.reserve_rollback_slot(uuid, uuid, uuid, uuid, char, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION nano.generation_capacity_occupied() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.reserve_rollback_slot(uuid, uuid, uuid, uuid, char, uuid, integer) TO nano_api;
GRANT EXECUTE ON FUNCTION nano.generation_capacity_occupied() TO nano_api;

-- One definition of "occupied" for the whole system. This keeps the existing
-- callers (generation claim, restore claim, rollback claim) correct without
-- repeating the formula, and means a rollback or restore that already holds a
-- slot is never counted as free capacity by any of them.
CREATE OR REPLACE FUNCTION nano.reserve_generation_capacity(ceiling integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
BEGIN
  IF ceiling IS NULL OR ceiling < 1 OR ceiling > 100 THEN
    RAISE EXCEPTION 'invalid generation capacity';
  END IF;
  -- Held until the caller's transaction commits or rolls back.
  PERFORM pg_advisory_xact_lock(423194820751::bigint);
  RETURN nano.generation_capacity_occupied() < ceiling;
END;
$$;

-- Restore needs the same atomic admission as rollback: it creates a sandbox and
-- therefore draws on the same ledger, and its row has to commit together with
-- the decision so no other operation can take the slot in between.
CREATE FUNCTION nano.reserve_restore_slot(p_owner uuid, p_project uuid, p_revision uuid,
  p_source_hash char(64), p_idempotency uuid, p_ceiling integer)
RETURNS nano.preview_restores
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE
  v_admitted boolean;
  v_row nano.preview_restores;
BEGIN
  PERFORM pg_advisory_xact_lock(423194820751::bigint);
  v_admitted := nano.reserve_generation_capacity(p_ceiling);
  INSERT INTO nano.preview_restores (id,owner_id,project_id,revision_id,source_hash,idempotency_key,status)
  VALUES (gen_random_uuid(),p_owner,p_project,p_revision,p_source_hash,p_idempotency,
    CASE WHEN v_admitted THEN 'pending' ELSE 'queued' END)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION nano.reserve_restore_slot(uuid, uuid, uuid, char, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.reserve_restore_slot(uuid, uuid, uuid, char, uuid, integer) TO nano_api;
