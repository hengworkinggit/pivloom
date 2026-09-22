ALTER TABLE nano.runs
  ALTER COLUMN builder_role_run_id DROP NOT NULL,
  ADD COLUMN coordinator_role_run_id uuid,
  ADD COLUMN plan_json jsonb CHECK(plan_json IS NULL OR (jsonb_typeof(plan_json)='object' AND octet_length(plan_json::text)<=32768)),
  ADD COLUMN clarification_json jsonb CHECK(clarification_json IS NULL OR (jsonb_typeof(clarification_json)='object' AND octet_length(clarification_json::text)<=4096)),
  ADD COLUMN planning_context_json jsonb CHECK(planning_context_json IS NULL OR (jsonb_typeof(planning_context_json)='object' AND octet_length(planning_context_json::text)<=98304)),
  ADD CONSTRAINT run_coordinator_role FOREIGN KEY(coordinator_role_run_id,id,owner_id)
    REFERENCES nano.role_runs(id,run_id,owner_id) DEFERRABLE INITIALLY DEFERRED;
