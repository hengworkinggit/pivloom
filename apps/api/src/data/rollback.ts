import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient, QueryResultRow } from "pg";
import type { RollbackOperation } from "@pivloom/contracts";
import type { PivloomDatabase } from "./database.js";
import { ApiFailure } from "../routes/errors.js";

type Row = QueryResultRow;
export interface StoredRollback extends RollbackOperation {
  ownerId: string;
  sandboxId: string | null;
  expiresAt: string | null;
}
export interface StaleRollbackClaim {
  id: string; ownerId: string; projectId: string; sandboxId: string | null; status: StoredRollback["status"];
  expiresAt?: string;
}
const notFound = () => new ApiFailure(404, "NOT_FOUND", "找不到这个项目资源。");
const stamp = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
function stored(row: Row): StoredRollback {
  return {
    id: row.id, ownerId: row.owner_id, projectId: row.project_id,
    fromRevisionId: row.from_revision_id, targetRevisionId: row.target_revision_id,
    sourceHash: row.source_hash, status: row.status, sandboxId: row.sandbox_id ?? null,
    expiresAt: row.expires_at ? stamp(row.expires_at) : null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null,
    createdAt: stamp(row.created_at), finishedAt: row.finished_at ? stamp(row.finished_at) : null,
  };
}

/** Rollback has its own durable state. The project row is the shared lock used
 * by generation and preview restore, and every transition locks it first. */
export function createRollbackRepository(
  database: Pick<PivloomDatabase, "owned" | "system">,
  options: { maxSandboxes: number },
) {
  const maxSandboxes = options.maxSandboxes;
  async function parent(client: PoolClient, ownerId: string, projectId: string) {
    const row = (await client.query("SELECT * FROM nano.projects WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, projectId])).rows[0];
    if (!row) throw notFound();
    return row;
  }
  async function operation(client: PoolClient, ownerId: string, projectId: string, id: string) {
    const row = (await client.query("SELECT * FROM nano.rollbacks WHERE owner_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [ownerId, projectId, id])).rows[0];
    if (!row) throw notFound();
    return row;
  }
  async function release(client: PoolClient, ownerId: string, projectId: string, id: string) {
    await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, projectId, id]);
  }
  return {
    async begin(ownerId: string, projectId: string, input: {
      targetRevisionId: string; expectedCurrentRevisionId: string; idempotencyKey: string;
    }): Promise<{ operation: StoredRollback; replayed: boolean }> {
      if (![input.targetRevisionId, input.expectedCurrentRevisionId, input.idempotencyKey].every((id) => z.uuid().safeParse(id).success))
        throw new ApiFailure(422, "INVALID_INPUT", "回滚版本或请求标识格式不正确。");
      return database.owned(ownerId, async (client) => {
        const project = await parent(client, ownerId, projectId);
        const previous = (await client.query("SELECT * FROM nano.rollbacks WHERE owner_id=$1 AND project_id=$2 AND idempotency_key=$3", [ownerId, projectId, input.idempotencyKey])).rows[0];
        if (previous) {
          if (previous.from_revision_id !== input.expectedCurrentRevisionId || previous.target_revision_id !== input.targetRevisionId)
            throw new ApiFailure(409, "IDEMPOTENCY_CONFLICT", "同一请求标识对应的回滚版本不同。");
          return { operation: stored(previous), replayed: true };
        }
        if (project.current_revision_id !== input.expectedCurrentRevisionId)
          throw new ApiFailure(409, "STALE_BASE", "当前版本已经变化，请刷新项目后重试。");
        if (project.operation_id) throw new ApiFailure(409, "PROJECT_BUSY", "当前项目仍有执行或清理操作。", true);
        if (input.targetRevisionId === input.expectedCurrentRevisionId)
          throw new ApiFailure(422, "ALREADY_CURRENT", "目标版本已经是当前版本。");
        const target = (await client.query(`SELECT v.* FROM nano.revisions v
          JOIN nano.checks c ON c.owner_id=v.owner_id AND c.project_id=v.project_id
            AND c.revision_id=v.id AND c.source_hash=v.source_hash AND c.verdict='passed'
          WHERE v.owner_id=$1 AND v.project_id=$2 AND v.id=$3
            AND v.status='accepted' AND v.build_status='passed'`,
        [ownerId, projectId, input.targetRevisionId])).rows[0];
        if (!target) throw new ApiFailure(409, "ROLLBACK_TARGET_NOT_ACCEPTED", "只能回滚到本项目已验收且通过检查的版本。");
        // A rollback rebuilds and re-checks the target revision in its own
        // sandbox, so it takes a slot from the same capacity ledger the
        // generation queue reserves from instead of overselling the ceiling.
        if ((await client.query("SELECT nano.reserve_generation_capacity($1) AS admitted", [maxSandboxes])).rows[0].admitted !== true)
          throw new ApiFailure(409, "SERVICE_BUSY", "沙箱容量已满，请在当前预览结束后重试。", true);
        const id = randomUUID();
        const row = (await client.query(`INSERT INTO nano.rollbacks
          (id,owner_id,project_id,from_revision_id,target_revision_id,source_hash,idempotency_key,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,'preparing') RETURNING *`,
        [id, ownerId, projectId, input.expectedCurrentRevisionId, input.targetRevisionId, target.source_hash, input.idempotencyKey])).rows[0];
        await client.query("UPDATE nano.projects SET operation_kind='rollback',operation_id=$3,operation_started_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, projectId, id]);
        return { operation: stored(row), replayed: false };
      });
    },
    async get(ownerId: string, projectId: string, id: string): Promise<StoredRollback> {
      return database.owned(ownerId, async (client) => {
        const row = (await client.query("SELECT * FROM nano.rollbacks WHERE owner_id=$1 AND project_id=$2 AND id=$3", [ownerId, projectId, id])).rows[0];
        if (!row) throw notFound();
        return stored(row);
      });
    },
    async committedForBinding(ownerId: string, projectId: string, revisionId: string, sandboxId: string): Promise<StoredRollback | null> {
      return database.owned(ownerId, async (client) => {
        const row = (await client.query(`SELECT * FROM nano.rollbacks WHERE owner_id=$1 AND project_id=$2
          AND target_revision_id=$3 AND sandbox_id=$4 AND status='committed' ORDER BY finished_at DESC LIMIT 1`,
        [ownerId, projectId, revisionId, sandboxId])).rows[0];
        return row ? stored(row) : null;
      });
    },
    async registerSandbox(ownerId: string, projectId: string, id: string, input: { sandboxId: string; expiresAt: string }): Promise<StoredRollback> {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(input.sandboxId) || !z.iso.datetime().safeParse(input.expiresAt).success)
        throw new ApiFailure(422, "INVALID_SANDBOX_BINDING", "沙箱标识或有效期无效。");
      return database.owned(ownerId, async (client) => {
        const project = await parent(client, ownerId, projectId), row = await operation(client, ownerId, projectId, id);
        // A concurrent cancel may win just after remote create returned its ID.
        // Record that exact resource anyway, so cancellation can confirm kill.
        if (!["preparing", "cancel_requested"].includes(row.status) || project.operation_id !== id)
          throw new ApiFailure(409, "ROLLBACK_NOT_ACTIVE", "回滚已结束或正在清理。");
        if (row.sandbox_id) {
          if (row.sandbox_id !== input.sandboxId) throw new ApiFailure(409, "ROLLBACK_BINDING_MISMATCH", "回滚已登记其它沙箱。");
          return stored(row);
        }
        const revision = (await client.query("SELECT run_id,attempt FROM nano.revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3", [ownerId, projectId, row.target_revision_id])).rows[0];
        if (!revision) throw notFound();
        await client.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,revision_id,source_hash,purpose,state,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'preview','creating',$8)`,
        [ownerId, projectId, revision.run_id, revision.attempt, input.sandboxId, row.target_revision_id, row.source_hash, input.expiresAt]);
        const changed = (await client.query("UPDATE nano.rollbacks SET sandbox_id=$4,expires_at=$5 WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *",
          [ownerId, projectId, id, input.sandboxId, input.expiresAt])).rows[0];
        return stored(changed);
      });
    },
    async markPrepared(ownerId: string, projectId: string, id: string, input: {
      sandboxId: string; sourceHash: string; markerVerified: true; filesVerified: true; writeRevoked: true;
    }): Promise<StoredRollback> {
      return database.owned(ownerId, async (client) => {
        const project = await parent(client, ownerId, projectId), row = await operation(client, ownerId, projectId, id);
        if (row.status !== "preparing" || project.operation_id !== id) throw new ApiFailure(409, "ROLLBACK_NOT_ACTIVE", "回滚已结束或正在清理。");
        if (row.sandbox_id !== input.sandboxId || row.source_hash !== input.sourceHash
          || input.markerVerified !== true || input.filesVerified !== true || input.writeRevoked !== true)
          throw new ApiFailure(409, "ROLLBACK_BINDING_MISMATCH", "回滚源码、预览或安全边界未通过核验。");
        const binding = (await client.query(`SELECT id FROM nano.sandboxes WHERE owner_id=$1 AND project_id=$2 AND remote_id=$3
          AND revision_id=$4 AND source_hash=$5 AND purpose='preview' AND state='creating'`,
        [ownerId, projectId, input.sandboxId, row.target_revision_id, row.source_hash])).rows[0];
        if (!binding) throw new ApiFailure(409, "ROLLBACK_BINDING_MISMATCH", "回滚沙箱绑定已失效。");
        const changed = (await client.query("UPDATE nano.rollbacks SET status='prepared',prepared_at=now() WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *", [ownerId, projectId, id])).rows[0];
        return stored(changed);
      });
    },
    async commit(ownerId: string, projectId: string, id: string): Promise<StoredRollback> {
      return database.owned(ownerId, async (client) => {
        const project = await parent(client, ownerId, projectId), row = await operation(client, ownerId, projectId, id);
        if (row.status === "committed") return stored(row);
        if (row.status !== "prepared" || project.operation_id !== id || project.current_revision_id !== row.from_revision_id)
          throw new ApiFailure(409, "ROLLBACK_NOT_ACTIVE", "回滚已结束，或当前版本发生变化。");
        const target = (await client.query(`SELECT v.revision_no FROM nano.revisions v
          JOIN nano.checks c ON c.owner_id=v.owner_id AND c.project_id=v.project_id AND c.revision_id=v.id
            AND c.source_hash=v.source_hash AND c.verdict='passed'
          WHERE v.owner_id=$1 AND v.project_id=$2 AND v.id=$3 AND v.source_hash=$4
            AND v.status='accepted' AND v.build_status='passed'`,
        [ownerId, projectId, row.target_revision_id, row.source_hash])).rows[0];
        if (!target) throw new ApiFailure(409, "ROLLBACK_TARGET_NOT_ACCEPTED", "目标版本不再满足验收条件。");
        const from = (await client.query("SELECT revision_no FROM nano.revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3", [ownerId, projectId, row.from_revision_id])).rows[0];
        const binding = (await client.query(`UPDATE nano.sandboxes SET state='active',last_checked_at=now()
          WHERE owner_id=$1 AND project_id=$2 AND remote_id=$3 AND revision_id=$4 AND source_hash=$5
            AND purpose='preview' AND state='creating' AND expires_at>now() RETURNING id`,
        [ownerId, projectId, row.sandbox_id, row.target_revision_id, row.source_hash])).rows[0];
        if (!binding) throw new ApiFailure(409, "ROLLBACK_BINDING_MISMATCH", "回滚预览已失效，未切换当前版本。");
        await client.query("UPDATE nano.projects SET current_revision_id=$3,operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$4", [ownerId, projectId, row.target_revision_id, id]);
        const changed = (await client.query("UPDATE nano.rollbacks SET status='committed',finished_at=now() WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *", [ownerId, projectId, id])).rows[0];
        await client.query(`INSERT INTO nano.messages(owner_id,project_id,run_id,rollback_id,kind,content)
          VALUES($1,$2,NULL,$3,'rollback',$4)`,
        [ownerId, projectId, id, `已从 v${from.revision_no} 回滚到 v${target.revision_no}。后续修改将以 v${target.revision_no} 为基线。`]);
        return stored(changed);
      });
    },
    async cancel(ownerId: string, projectId: string, id: string): Promise<StoredRollback> {
      return database.owned(ownerId, async (client) => {
        const project = await parent(client, ownerId, projectId), row = await operation(client, ownerId, projectId, id);
        if (["committed", "failed", "cancelled", "cleanup_pending"].includes(row.status)) return stored(row);
        if (project.operation_id !== id) throw new ApiFailure(409, "ROLLBACK_NOT_ACTIVE", "回滚已结束。");
        const changed = (await client.query(`UPDATE nano.rollbacks SET status='cancel_requested',error_code='CANCELLED',
          error_message='回滚已取消，正在确认远端资源清理。' WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *`,
        [ownerId, projectId, id])).rows[0];
        return stored(changed);
      });
    },
    async fail(ownerId: string, projectId: string, id: string, input: { code: string; message: string }): Promise<StoredRollback> {
      return database.owned(ownerId, async (client) => {
        const project = await parent(client, ownerId, projectId), row = await operation(client, ownerId, projectId, id);
        if (["committed", "failed", "cancelled"].includes(row.status)) return stored(row);
        const sandbox = row.sandbox_id ? (await client.query(`SELECT state FROM nano.sandboxes WHERE owner_id=$1 AND project_id=$2
          AND remote_id=$3 AND revision_id=$4 AND purpose='preview'`,
        [ownerId, projectId, row.sandbox_id, row.target_revision_id])).rows[0] : null;
        const cleanupPending = Boolean(row.sandbox_id && (!sandbox || !["destroyed", "expired"].includes(sandbox.state)));
        const cancelled = row.status === "cancel_requested" || input.code === "CANCELLED";
        const status = cleanupPending ? "cleanup_pending" : cancelled ? "cancelled" : "failed";
        const changed = (await client.query(`UPDATE nano.rollbacks SET status=$4,error_code=$5,error_message=$6,
          finished_at=CASE WHEN $7::boolean THEN NULL ELSE now() END
          WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *`,
        [ownerId, projectId, id, status, cancelled ? "CANCELLED" : input.code.slice(0, 80), input.message.slice(0, 2000), cleanupPending])).rows[0];
        if (!cleanupPending && project.operation_id === id) await release(client, ownerId, projectId, id);
        return stored(changed);
      });
    },
    async markSandboxDestroyed(ownerId: string, projectId: string, id: string, sandboxId: string): Promise<StoredRollback> {
      return database.owned(ownerId, async (client) => {
        const project = await parent(client, ownerId, projectId), row = await operation(client, ownerId, projectId, id);
        if (row.sandbox_id !== sandboxId) throw new ApiFailure(409, "ROLLBACK_BINDING_MISMATCH", "清理目标与回滚绑定不一致。");
        if (row.status === "committed") throw new ApiFailure(409, "ROLLBACK_ALREADY_COMMITTED", "已提交的预览不能按失败回收。");
        await client.query(`UPDATE nano.sandboxes SET state='destroyed',last_checked_at=now()
          WHERE owner_id=$1 AND project_id=$2 AND remote_id=$3 AND revision_id=$4 AND purpose='preview'`,
        [ownerId, projectId, sandboxId, row.target_revision_id]);
        const status = row.error_code === "CANCELLED" ? "cancelled" : "failed";
        const changed = (await client.query(`UPDATE nano.rollbacks SET status=$4,finished_at=now(),
          error_code=coalesce(error_code,'ROLLBACK_INTERRUPTED'),
          error_message=coalesce(error_message,'回滚准备已中断，旧版本保持不变。')
          WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *`, [ownerId, projectId, id, status])).rows[0];
        if (project.operation_id === id) await release(client, ownerId, projectId, id);
        return stored(changed);
      });
    },
    async markCommittedSandboxDestroyed(ownerId: string, projectId: string, id: string, sandboxId: string): Promise<void> {
      await database.owned(ownerId, async (client) => {
        await parent(client, ownerId, projectId);
        const row = await operation(client, ownerId, projectId, id);
        if (row.status !== "committed" || row.sandbox_id !== sandboxId)
          throw new ApiFailure(409, "ROLLBACK_BINDING_MISMATCH", "到期清理目标与已提交回滚不一致。");
        await client.query(`UPDATE nano.sandboxes SET state='destroyed',last_checked_at=now()
          WHERE owner_id=$1 AND project_id=$2 AND remote_id=$3 AND revision_id=$4 AND purpose='preview'`,
        [ownerId, projectId, sandboxId, row.target_revision_id]);
      });
    },
    async committedActivePreviews(): Promise<StaleRollbackClaim[]> {
      return database.system(async (client) => {
        const rows = await client.query("SELECT * FROM nano.list_committed_rollback_previews()");
        return rows.rows.map((row) => ({ id: row.o_rollback_id, ownerId: row.o_owner_id,
          projectId: row.o_project_id, sandboxId: row.o_sandbox_id,
          status: "committed" as const, expiresAt: stamp(row.o_expires_at) }));
      });
    },
    async claimStale(): Promise<StaleRollbackClaim[]> {
      return database.system(async (client) => {
        const rows = await client.query("SELECT * FROM nano.claim_stale_rollbacks()");
        return rows.rows.map((row) => ({ id: row.o_rollback_id, ownerId: row.o_owner_id,
          projectId: row.o_project_id, sandboxId: row.o_sandbox_id,
          status: row.o_status as StoredRollback["status"] }));
      });
    },
  };
}
export type RollbackRepository = ReturnType<typeof createRollbackRepository>;
