-- 021: correct the queue ordering key and the position it reports.
--
-- Migration 020 shipped with three defects that only show once more than one
-- task is waiting, so 020 is left exactly as it was applied and this migration
-- redefines the affected functions.
--
-- 1. The order key used nano.runs.queued_at, which is timestamptz(3). Several
--    requests accepted inside the same millisecond therefore shared a key and
--    the order fell through to comparing random run ids, which is not the
--    submission order the queue promises. created_at keeps microsecond
--    precision, so the key now distinguishes those requests.
-- 2. Position was counted with a row comparison over (last_dispatch, ...).
--    Comparing against a NULL last_dispatch is unknown rather than true, so a
--    task whose owner had never been dispatched was not counted and the
--    position reported to the user was too high.
-- 3. Dispatch and position computed the key separately, so they could disagree.
--    The rank is now computed once inside nano.queue_candidates and dispatch
--    sorts by that rank, which makes "第 N 位" the order work really starts in
--    by construction.
--
-- It also fixes per-project serialisation: of several tasks queued for one
-- project only the earliest is dispatchable. Without that check an earlier task
-- is still 'queued' when a later sibling looks for a live run, finds none, and
-- overtakes it, so one project could run two tasks at once.

CREATE OR REPLACE FUNCTION nano.queue_candidates()
RETURNS TABLE(run_id uuid, owner_id uuid, project_id uuid, queued_at timestamptz,
  last_dispatch timestamptz, blocked boolean, queue_position bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  WITH scored AS (
    SELECT r.id, r.owner_id, r.project_id, r.queued_at,
      (SELECT max(d.dispatched_at) FROM nano.runs d
        WHERE d.owner_id = r.owner_id AND d.dispatched_at IS NOT NULL) AS last_dispatch,
      (p.operation_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM nano.runs a
          WHERE a.project_id = r.project_id AND a.id <> r.id
            AND (a.state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
              OR a.cleanup_state = 'pending'))
        OR EXISTS (SELECT 1 FROM nano.runs s
          WHERE s.project_id = r.project_id AND s.state = 'queued' AND s.id <> r.id
            AND (coalesce((SELECT max(d.dispatched_at) FROM nano.runs d
                    WHERE d.owner_id = s.owner_id AND d.dispatched_at IS NOT NULL), '-infinity'::timestamptz),
                  s.created_at, s.id)
              < (coalesce((SELECT max(d.dispatched_at) FROM nano.runs d
                    WHERE d.owner_id = r.owner_id AND d.dispatched_at IS NOT NULL), '-infinity'::timestamptz),
                  r.created_at, r.id))) AS blocked,
      r.created_at
    FROM nano.runs r
    JOIN nano.projects p ON p.id = r.project_id AND p.owner_id = r.owner_id
    WHERE r.state = 'queued'
  ), ranked AS (
    SELECT q.*,
      (SELECT count(*) + 1 FROM scored a
        WHERE NOT a.blocked
          AND (a.last_dispatch IS NULL OR a.last_dispatch < q.last_dispatch
            OR (a.last_dispatch IS NOT DISTINCT FROM q.last_dispatch
              AND (a.created_at < q.created_at
                OR (a.created_at = q.created_at AND a.id < q.id))))) AS position
    FROM scored q
  )
  -- The rank is computed here and only the published columns are returned, so a
  -- caller that joins this function cannot collide with nano.runs.created_at.
  SELECT r.id, r.owner_id, r.project_id, r.queued_at, r.last_dispatch, r.blocked,
    CASE WHEN r.blocked THEN NULL ELSE r.position END
  FROM ranked r;
$$;

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
  -- The reported position is the dispatch order, so dispatch sorts by it instead
  -- of repeating the key: one definition cannot drift from the other. A blocked
  -- row has no position, and blocked rows are exactly the ones to skip.
  SELECT c.run_id INTO v_run
  FROM nano.queue_candidates() c
  WHERE NOT c.blocked
    AND (p_run IS NULL OR c.run_id = p_run)
    AND (p_owner IS NULL OR c.owner_id = p_owner)
  ORDER BY c.queue_position
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
  -- the scheduler re-reads it through nano.claim_dispatch_event and publishes it.
  INSERT INTO nano.run_events (owner_id, project_id, run_id, role_run_id, attempt, type, payload_json)
  SELECT r.owner_id, r.project_id, r.id, NULL, r.attempt, 'run.accepted',
    jsonb_build_object('state','accepted','phase','plan','dispatched',true)
  FROM nano.runs r WHERE r.id = v_run;
  RETURN QUERY SELECT * FROM nano.runs WHERE id = v_run;
END;
$$;

-- Reads back the dispatch event a claim just wrote. The claim runs on the
-- owner-less dispatch connection, where row level security on nano.run_events
-- hides every row, so publishing the transition out of the queue to an
-- already-open stream needs the same narrow SECURITY DEFINER reader the
-- recovery scans use. Without it the scheduler can durably record the dispatch
-- but never deliver it, and a waiting client keeps showing "已排队".
CREATE OR REPLACE FUNCTION nano.claim_dispatch_event(p_run uuid)
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
REVOKE ALL ON FUNCTION nano.claim_dispatch_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.queue_candidates() TO nano_api;
GRANT EXECUTE ON FUNCTION nano.claim_next_queued_run(uuid, integer, uuid, uuid) TO nano_api;
GRANT EXECUTE ON FUNCTION nano.claim_dispatch_event(uuid) TO nano_api;
