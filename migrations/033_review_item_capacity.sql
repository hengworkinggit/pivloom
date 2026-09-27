-- A 64-behaviour real replay produced a 54 KiB item report with valid browser
-- citations. Keep the database bound aligned with the 80-item contract so a
-- completed replay can be saved instead of becoming an all-blocked result.
ALTER TABLE nano.checks DROP CONSTRAINT checks_items_json_check;
ALTER TABLE nano.checks ADD CONSTRAINT checks_items_json_check
  CHECK(jsonb_typeof(items_json)='array' AND octet_length(items_json::text)<=131072);
