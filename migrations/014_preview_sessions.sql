-- A Supabase access token can remain valid after local signOut. Private Preview
-- requests need the corresponding auth.sessions row to exist at request time.
-- The API's nano_api role may ask only this boolean question; it cannot read
-- auth.sessions directly, and anon/authenticated receive no execute privilege.
CREATE OR REPLACE FUNCTION nano.preview_session_active(p_owner uuid, p_session uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM auth.sessions
    WHERE id = p_session AND user_id = p_owner
  );
END;
$$;

REVOKE ALL ON FUNCTION nano.preview_session_active(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.preview_session_active(uuid, uuid) TO nano_api;
