-- The public preview entry needs a TLS certificate per revision subdomain, and
-- Caddy only asks for one it is authorised to issue. Authorising every hostname
-- would let anyone burn the certificate rate limit, so the check is limited to
-- subdomains whose revision actually exists. Revisions are owned per account and
-- this runs before any identity exists, so it needs the same SECURITY DEFINER
-- shape as the recovery scan.

CREATE OR REPLACE FUNCTION nano.revision_exists(p_revision uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nano, pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM nano.revisions WHERE id = p_revision);
$$;

REVOKE ALL ON FUNCTION nano.revision_exists(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.revision_exists(uuid) TO nano_api;
