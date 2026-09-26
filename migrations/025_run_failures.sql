-- 025: failures are data, not prose.
--
-- Every boundary in the executor translates errors, and the catch-all used to
-- keep the real cause only on the server console while the run record held a
-- generic sentence. That is why a ZodError from an over-long evidence array
-- looked like an unreproducible GENERATION_FAILED for a night. This table keeps
-- the classified cause next to the run so the workbench can show it directly.
--
-- One row per run: a run reaches one terminal failure, and the row is replaced
-- if a retried attempt fails again so the detail always matches the visible
-- error on the run.
CREATE TABLE IF NOT EXISTS nano.run_failures (
  run_id uuid PRIMARY KEY REFERENCES nano.runs(id) ON DELETE CASCADE,
  phase text NOT NULL,
  code text NOT NULL,
  cause_class text NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
