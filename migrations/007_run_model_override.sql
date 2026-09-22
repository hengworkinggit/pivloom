-- A run freezes the exact model used alongside the provider credential and its
-- config version. This is the per-run/session model override layer (#3): the
-- profile remains a provider credential (provider + base URL + encrypted key +
-- default model), while any run may pin a different catalog model under the same
-- endpoint without duplicating the credential.
ALTER TABLE nano.runs
  ADD COLUMN model_id text CHECK(model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 160);
