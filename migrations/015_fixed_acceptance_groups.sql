-- New plans carry five stable groups and every atomic behavior. Historical
-- schemaVersion 1 plans/checks remain unchanged and have no group result.
ALTER TABLE nano.runs
  DROP CONSTRAINT runs_plan_json_check,
  DROP CONSTRAINT runs_planning_context_json_check,
  ADD CONSTRAINT runs_plan_json_check CHECK(plan_json IS NULL OR
    (jsonb_typeof(plan_json)='object' AND octet_length(plan_json::text)<=131072)),
  ADD CONSTRAINT runs_planning_context_json_check CHECK(planning_context_json IS NULL OR
    (jsonb_typeof(planning_context_json)='object' AND octet_length(planning_context_json::text)<=262144));

ALTER TABLE nano.checks
  ADD COLUMN group_results_json jsonb,
  ADD CONSTRAINT checks_group_results_json_check CHECK(group_results_json IS NULL OR
    (jsonb_typeof(group_results_json)='array' AND jsonb_array_length(group_results_json)=5
      AND octet_length(group_results_json::text)<=32768));
