-- A working candidate and the accepted revision used for CAS are different
-- identities. Default queued requests may chain; explicit selections may not.
ALTER TABLE nano.runs ADD COLUMN selected_base_revision_id uuid,
  ADD CONSTRAINT run_selected_candidate
  FOREIGN KEY(selected_base_revision_id,project_id,owner_id)
  REFERENCES nano.revisions(id,project_id,owner_id) DEFERRABLE INITIALLY DEFERRED;
