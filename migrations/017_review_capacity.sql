-- A grouped plan may contain 80 checks. Each passing interactive check needs
-- its own post-action PNG; the old 16 KiB metadata constraint rejected a valid
-- 80-artifact receipt even though the images themselves live in private Storage.
ALTER TABLE nano.checks
  DROP CONSTRAINT checks_artifacts_json_check,
  ADD CONSTRAINT checks_artifacts_json_check CHECK (
    jsonb_typeof(artifacts_json) = 'array'
    AND octet_length(artifacts_json::text) <= 65536
  );
