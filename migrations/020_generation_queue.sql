-- 020: durable admission queue for generation capacity.
--
-- A legal request is persisted as a 'queued' run instead of being refused with
-- SERVICE_BUSY. A queued run holds no sandbox, no model call, no execution
-- budget and no execution idle timeout: it only becomes 'accepted' when the
-- scheduler atomically claims the run row, the project operation lock and a
-- capacity slot in one transaction.

ALTER TABLE nano.runs DROP CONSTRAINT runs_state_check;
ALTER TABLE nano.runs ADD CONSTRAINT runs_state_check CHECK (state IN (
  'queued','accepted','planning','building','verifying','repairing','finalizing',
  'cancel_requested','completed','needs_changes','needs_input','failed','cancelled','interrupted'));

ALTER TABLE nano.runs
  ADD COLUMN queued_at timestamptz(3),
  ADD COLUMN dispatched_at timestamptz(3);

-- Rows created before this migration were dispatched by admission itself.
UPDATE nano.runs SET queued_at = created_at WHERE queued_at IS NULL;
UPDATE nano.runs SET dispatched_at = created_at
  WHERE dispatched_at IS NULL
    AND state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested');

CREATE INDEX runs_queue_order ON nano.runs(queued_at, id) WHERE state = 'queued';
CREATE INDEX runs_owner_dispatched ON nano.runs(owner_id, dispatched_at DESC) WHERE dispatched_at IS NOT NULL;

-- Single source of truth for queue order, shared by dispatch and by the owner
-- task list. The dispatch key is (owner's last dispatch, submission time): an
-- owner with a backlog is served once and then yields to owners that waited.
-- A task is blocked while its project still owns an operation or a live run, so
-- a project's writes stay serial. Position counts only the tasks that can
-- actually be dispatched ahead of this one; a task that is itself blocked would
-- otherwise claim a place in line it is not yet competing for, and a "第 N 位"
-- the user reads would not match the order work really starts in.
CREATE FUNCTION nano.queue_candidates()
RETURNS TABLE(run_id uuid, owner_id uuid, project_id uuid, queued_at timestamptz,
  last_dispatch timestamptz, blocked boolean, queue_position bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  WITH queued AS (
    SELECT r.id, r.owner_id, r.project_id, r.queued_at,
      (SELECT max(d.dispatched_at) FROM nano.runs d
        WHERE d.owner_id = r.owner_id AND d.dispatched_at IS NOT NULL) AS last_dispatch,
      (p.operation_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM nano.runs a
          WHERE a.project_id = r.project_id AND a.id <> r.id
            AND (a.state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
              OR a.cleanup_state = 'pending'))) AS blocked
    FROM nano.runs r
    JOIN nano.projects p ON p.id = r.project_id AND p.owner_id = r.owner_id
    WHERE r.state = 'queued'
  )
  SELECT q.id, q.owner_id, q.project_id, q.queued_at, q.last_dispatch, q.blocked,
    CASE WHEN q.blocked THEN NULL ELSE (
      SELECT count(*) + 1 FROM queued a
      WHERE NOT a.blocked
        AND (a.last_dispatch, a.queued_at, a.id) < (q.last_dispatch, q.queued_at, q.id)
    ) END
  FROM queued q;
$$;

-- Claims at most one queued run. nano.reserve_generation_capacity takes the same
-- transaction-scoped advisory lock and counts every live slot, so claims can
-- never oversell capacity and a claim holds the slot until it commits.
--
-- Lock order is fixed: the advisory lock, then the project row, then the run row.
-- nano.lockedRun in the API locks the project before the run as well, so a user
-- cancelling a task cannot deadlock against a concurrent claim. p_owner narrows
-- the claim to one account: dispatch passes NULL, an owner-scoped caller must
-- pass its own id so it can never claim another account's task.
CREATE FUNCTION nano.claim_next_queued_run(p_boot uuid, p_ceiling integer, p_run uuid DEFAULT NULL, p_owner uuid DEFAULT NULL)
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
  -- Dispatch order and the reported position must be the same ordering, or the
  -- "第 N 位" a user reads would not be the order work really starts in.
  SELECT c.run_id INTO v_run
  FROM nano.queue_candidates() c
  WHERE NOT c.blocked
    AND (p_run IS NULL OR c.run_id = p_run)
    AND (p_owner IS NULL OR c.owner_id = p_owner)
  ORDER BY c.last_dispatch ASC NULLS FIRST, c.queued_at ASC, c.run_id ASC
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
  -- The transition out of the queue is a durable event: without it a client that
  -- is streaming would only learn about dispatch from the next phase update. It
  -- is written on the dispatch connection rather than a caller transaction, so
  -- the scheduler re-reads it after the claim and publishes it to subscribers.
  INSERT INTO nano.run_events (owner_id, project_id, run_id, role_run_id, attempt, type, payload_json)
  SELECT r.owner_id, r.project_id, r.id, NULL, r.attempt, 'run.accepted',
    jsonb_build_object('state','accepted','phase','plan','dispatched',true)
  FROM nano.runs r WHERE r.id = v_run;
  RETURN QUERY SELECT * FROM nano.runs WHERE id = v_run;
END;
$$;

-- A run that was claimed but whose handoff to the executor never completed stays
-- 'accepted' with the project lock and a capacity slot held, and no boot scan can
-- reclaim it because it already carries the current boot id. This returns the
-- claims of the calling boot that are older than a grace period so the scheduler
-- can park them and let the queue advance.
CREATE FUNCTION nano.claim_stranded_runs(p_boot uuid, p_grace_seconds integer DEFAULT 60)
RETURNS TABLE(run_id uuid, owner_id uuid, project_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  SELECT r.id, r.owner_id, r.project_id
  FROM nano.runs r
  JOIN nano.projects p ON p.id = r.project_id AND p.owner_id = r.owner_id
  WHERE r.executor_boot_id = p_boot
    AND r.state = 'accepted'
    AND r.dispatched_at IS NOT NULL
    AND r.dispatched_at < now() - make_interval(secs => greatest(p_grace_seconds, 1))
    AND p.operation_id = r.id
    AND NOT EXISTS (SELECT 1 FROM nano.sandboxes s
      WHERE s.owner_id = r.owner_id AND s.run_id = r.id AND s.state IN ('creating','active'))
  ORDER BY r.dispatched_at;
$$;

-- Reads back the dispatch event a claim just wrote. The claim runs on the
-- owner-less dispatch connection, where row level security on nano.run_events
-- hides every row, so publishing the dispatch to an open stream needs the same
-- kind of narrow SECURITY DEFINER reader the recovery scans already use.
CREATE FUNCTION nano.claim_dispatch_event(p_run uuid)
RETURNS SETOF nano.run_events
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  SELECT e.* FROM nano.run_events e
  WHERE e.run_id = p_run AND e.type = 'run.accepted'
    AND e.payload_json->>'dispatched' = 'true'
  ORDER BY e.id DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION nano.queue_candidates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION nano.claim_next_queued_run(uuid, integer, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION nano.claim_stranded_runs(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION nano.claim_dispatch_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.queue_candidates() TO nano_api;
GRANT EXECUTE ON FUNCTION nano.claim_next_queued_run(uuid, integer, uuid, uuid) TO nano_api;
GRANT EXECUTE ON FUNCTION nano.claim_stranded_runs(uuid, integer) TO nano_api;
GRANT EXECUTE ON FUNCTION nano.claim_dispatch_event(uuid) TO nano_api;
