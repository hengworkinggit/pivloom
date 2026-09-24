-- A browser transport failure may be rechecked against the same immutable
-- candidate. Keep Builder/Coordinator unique per generation attempt while
-- allowing a completed Reviewer role to be followed by one fresh session.
ALTER TABLE nano.role_runs DROP CONSTRAINT role_runs_run_id_role_attempt_key;

CREATE UNIQUE INDEX role_runs_builder_coordinator_attempt_unique
  ON nano.role_runs(run_id, role, attempt)
  WHERE role IN ('builder', 'coordinator');

CREATE UNIQUE INDEX role_runs_active_reviewer_attempt_unique
  ON nano.role_runs(run_id, attempt)
  WHERE role = 'reviewer' AND state IN ('queued', 'running');
