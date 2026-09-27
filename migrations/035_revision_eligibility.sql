-- One release eligibility rule for publication and rollback. A curated starter
-- has a trusted build and page smoke check, while generated revisions have a
-- source-bound passing Reviewer Check.
CREATE FUNCTION nano.revision_eligible(p_owner uuid, p_project uuid, p_revision uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = nano, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM nano.revisions v
    JOIN nano.runs r ON r.id = v.run_id AND r.owner_id = v.owner_id AND r.project_id = v.project_id
    WHERE v.owner_id = p_owner AND v.project_id = p_project AND v.id = p_revision
      AND v.status = 'accepted' AND v.build_status = 'passed'
      AND r.state = 'completed' AND r.result_revision_id = v.id
      AND (
        EXISTS (
          SELECT 1 FROM nano.checks c
          WHERE c.owner_id = v.owner_id AND c.project_id = v.project_id
            AND c.run_id = v.run_id AND c.revision_id = v.id
            AND c.source_hash = v.source_hash AND c.verdict = 'passed'
        )
        OR (
          r.kind = 'template' AND r.template_slug = v.template_slug
          AND r.model_profile_id IS NULL AND r.credential_lease_id IS NULL
          AND v.build_json->>'schemaVersion' = '1'
          AND v.build_json->>'sourceHash' = v.source_hash
          AND v.build_json->'typecheck'->>'exitCode' = '0'
          AND v.build_json->'build'->>'exitCode' = '0'
        )
      )
  );
$$;
REVOKE ALL ON FUNCTION nano.revision_eligible(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION nano.revision_eligible(uuid,uuid,uuid) TO nano_api;
