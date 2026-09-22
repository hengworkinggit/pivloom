-- DEV-10: restore preview after sandbox expiry requires creating additional
-- preview-only sandboxes for the same originating run/attempt. The previous
-- global UNIQUE(run_id, attempt) only made sense while every run had at most
-- one candidate sandbox that later became its preview. We relax it to a
-- partial unique index that still guarantees a single candidate per attempt
-- while allowing multiple independent preview restore bindings.

ALTER TABLE nano.sandboxes DROP CONSTRAINT sandboxes_run_id_attempt_key;

CREATE UNIQUE INDEX sandboxes_one_candidate ON nano.sandboxes (run_id, attempt)
  WHERE purpose IN ('candidate', 'candidate-preview');

-- Preview restore operations acquire the project operation lock with their
-- own kind. The column already allows 'restore' via the projects CHECK.
