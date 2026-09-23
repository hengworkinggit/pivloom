-- RC-09: a rollback prepares a fresh preview before atomically changing current.
-- Its durable operation survives a process crash and is never represented as a
-- model Run. The existing project row serializes generate/restore/rollback.
ALTER TABLE nano.projects DROP CONSTRAINT projects_operation_kind_check;
ALTER TABLE nano.projects ADD CONSTRAINT projects_operation_kind_check
  CHECK (operation_kind IN ('generate','restore','rollback'));

CREATE TABLE nano.rollbacks (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  from_revision_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  source_hash char(64) NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key uuid NOT NULL,
  status text NOT NULL CHECK (status IN
    ('preparing','prepared','cancel_requested','cleanup_pending','committed','failed','cancelled')),
  sandbox_id text,
  expires_at timestamptz(3),
  error_code text,
  error_message text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  prepared_at timestamptz(3),
  finished_at timestamptz(3),
  UNIQUE (project_id,idempotency_key),
  UNIQUE (id,project_id,owner_id),
  FOREIGN KEY (project_id,owner_id) REFERENCES nano.projects(id,owner_id),
  FOREIGN KEY (from_revision_id,project_id,owner_id) REFERENCES nano.revisions(id,project_id,owner_id),
  FOREIGN KEY (target_revision_id,project_id,owner_id) REFERENCES nano.revisions(id,project_id,owner_id)
);
CREATE UNIQUE INDEX one_active_rollback_per_project ON nano.rollbacks(project_id)
  WHERE status IN ('preparing','prepared','cancel_requested','cleanup_pending');
ALTER TABLE nano.rollbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nano.rollbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON nano.rollbacks TO nano_api
  USING (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
REVOKE ALL ON nano.rollbacks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON nano.rollbacks TO nano_api;

ALTER TABLE nano.messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE nano.messages ADD CONSTRAINT messages_kind_check
  CHECK (kind IN ('user','result','question','rollback'));
ALTER TABLE nano.messages ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE nano.messages ADD COLUMN rollback_id uuid UNIQUE;
ALTER TABLE nano.messages ADD CONSTRAINT messages_origin_check CHECK
  ((kind='rollback' AND run_id IS NULL AND rollback_id IS NOT NULL) OR
   (kind<>'rollback' AND run_id IS NOT NULL AND rollback_id IS NULL));
ALTER TABLE nano.messages ADD CONSTRAINT messages_rollback_operation
  FOREIGN KEY (rollback_id,project_id,owner_id) REFERENCES nano.rollbacks(id,project_id,owner_id);

-- Called once before the API starts accepting work. A prepared operation may be
-- committed after re-verifying its marker; a merely preparing one cannot be
-- trusted and must release its sandbox first. Later sweeps retry only claimed IDs.
CREATE FUNCTION nano.claim_stale_rollbacks()
RETURNS TABLE(o_rollback_id uuid,o_owner_id uuid,o_project_id uuid,o_sandbox_id text,o_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = nano, pg_catalog AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE nano.rollbacks r SET
      status=CASE WHEN r.status='prepared' THEN 'prepared' ELSE 'cleanup_pending' END,
      error_code=CASE WHEN r.status='prepared' THEN r.error_code ELSE coalesce(r.error_code,'SERVICE_RESTARTED') END,
      error_message=CASE WHEN r.status='prepared' THEN r.error_message ELSE coalesce(r.error_message,'服务重启中断了回滚准备，正在确认沙箱清理。') END
    WHERE r.status IN ('preparing','prepared','cancel_requested','cleanup_pending')
    RETURNING r.id,r.owner_id,r.project_id,r.sandbox_id,r.status
  ) SELECT c.id,c.owner_id,c.project_id,c.sandbox_id,c.status FROM claimed c;
END $$;
REVOKE ALL ON FUNCTION nano.claim_stale_rollbacks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.claim_stale_rollbacks() TO nano_api;

-- Successful rollback previews also expire. List only their own persisted
-- bindings at boot; never infer ownership from the originating generation Run.
CREATE FUNCTION nano.list_committed_rollback_previews()
RETURNS TABLE(o_rollback_id uuid,o_owner_id uuid,o_project_id uuid,o_sandbox_id text,o_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nano, pg_catalog AS $$
  SELECT r.id,r.owner_id,r.project_id,r.sandbox_id,r.expires_at
  FROM nano.rollbacks r JOIN nano.sandboxes s ON s.owner_id=r.owner_id AND s.project_id=r.project_id
    AND s.remote_id=r.sandbox_id AND s.revision_id=r.target_revision_id AND s.purpose='preview'
  WHERE r.status='committed' AND r.sandbox_id IS NOT NULL AND s.state IN ('creating','active','destroying','error');
$$;
REVOKE ALL ON FUNCTION nano.list_committed_rollback_previews() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nano.list_committed_rollback_previews() TO nano_api;
