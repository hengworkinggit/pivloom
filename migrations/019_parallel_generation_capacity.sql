-- Admission is serialized across projects while preserving the per-project
-- unique active-run index. A run without a sandbox reserves one slot; a run
-- with a live sandbox consumes that sandbox's slot only once. Retained Preview
-- sandboxes continue to occupy capacity after their Run completes.
DROP INDEX nano.one_global_generation;

CREATE FUNCTION nano.reserve_generation_capacity(ceiling integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
DECLARE occupied integer;
BEGIN
  IF ceiling IS NULL OR ceiling < 1 OR ceiling > 100 THEN
    RAISE EXCEPTION 'invalid generation capacity';
  END IF;
  -- Held until the caller's accept transaction commits or rolls back.
  PERFORM pg_advisory_xact_lock(423194820751::bigint);
  SELECT (
    (SELECT count(*) FROM nano.sandboxes s
      WHERE s.state IN ('creating','active') AND s.expires_at > now())
    +
    (SELECT count(*) FROM nano.runs r
      WHERE (r.state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
        OR r.cleanup_state = 'pending')
        AND NOT EXISTS (SELECT 1 FROM nano.sandboxes s WHERE s.run_id = r.id
          AND s.state IN ('creating','active') AND s.expires_at > now()))
  )::integer INTO occupied;
  RETURN occupied < ceiling;
END;
$$;

REVOKE ALL ON FUNCTION nano.reserve_generation_capacity(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.reserve_generation_capacity(integer) TO nano_api;
