-- DEV-11: capacity must be counted from durable state, not from one process's
-- memory. An in-memory ledger forgets every live preview after a restart (so the
-- ceiling can be exceeded) and keeps counting a sandbox whose remote was already
-- reclaimed out of band (so new work is refused for a sandbox that no longer
-- exists). Both directions are wrong, and the registered rows already carry the
-- truth: state plus expiry.

CREATE OR REPLACE FUNCTION nano.live_sandbox_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  SELECT count(*)::integer
  FROM nano.sandboxes
  WHERE state IN ('creating','active') AND expires_at > now();
$$;

REVOKE ALL ON FUNCTION nano.live_sandbox_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.live_sandbox_count() TO nano_api;
