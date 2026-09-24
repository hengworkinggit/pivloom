import type { SourceStore } from "../storage/source.js";
import { sourceBundleFiles } from "../storage/source.js";
import type { GenerationRepository } from "../data/generation.js";
import type { RollbackRepository, StoredRollback, StaleRollbackClaim } from "../data/rollback.js";
import { OpenSandboxWorkspace, type SandboxConnector } from "../runtime/workspace.js";
import { RuntimeError, type SandboxConfig } from "../runtime/types.js";
import { RESTORE_TIMEOUT_MS } from "../runtime/budgets.js";
import { destroyCandidateSandbox } from "./candidate.js";
import { restorePreview } from "./restore.js";
import type { PreviewGateway } from "./preview.js";

interface RollbackTask { controller: AbortController; done: Promise<void> }
interface RollbackBoundaries { sandboxConnector?: SandboxConnector }

/** No model or Run is involved. The only side effect before the DB commit is
 * one registered, disposable sandbox; a failed or restarted preparation never
 * changes the project's current revision. */
export function createRollbackExecutor(options: {
  repository: RollbackRepository; generation: GenerationRepository; sources: SourceStore;
  previews: PreviewGateway; sandbox: SandboxConfig;
}, boundaries: RollbackBoundaries = {}) {
  const { repository, generation, sources, previews, sandbox } = options;
  const tasks = new Map<string, RollbackTask>();
  const claims = new Map<string, StaleRollbackClaim>();
  const reconciling = new Map<string, Promise<void>>();
  const retained = new Map<string, StoredRollback>();
  const retainedCleanup = new Map<string, Promise<void>>();
  // Remote create can return an ID just before its DB registration fails.
  // Retry that exact kill in-process; OpenSandbox's initial 180s TTL bounds a
  // simultaneous process crash before any durable binding could be written.
  const unregistered = new Set<string>();
  let closing = false;

  async function cleanExpiredCommitted(record: StoredRollback) {
    if (retainedCleanup.has(record.id)) return retainedCleanup.get(record.id)!;
    const task = (async () => {
      if (!record.sandboxId || !record.expiresAt || Date.parse(record.expiresAt) > Date.now()) return;
      const destroyed = await destroyCandidateSandbox({ sandboxConfig: sandbox, sandboxId: record.sandboxId,
        sandboxConnector: boundaries.sandboxConnector });
      if (!destroyed.confirmed) return;
      previews.revoke(record.targetRevisionId, record.sandboxId);
      await repository.markCommittedSandboxDestroyed(record.ownerId, record.projectId, record.id, record.sandboxId);
      retained.delete(record.id);
    })().finally(() => { retainedCleanup.delete(record.id); });
    retainedCleanup.set(record.id, task);
    return task;
  }

  async function verifiedEndpoint(record: StoredRollback) {
    if (!record.sandboxId || !record.expiresAt || Date.parse(record.expiresAt) <= Date.now())
      throw new RuntimeError("ROLLBACK_PREVIEW_EXPIRED", "回滚预览已过期，旧版本保持不变。");
    const workspace = new OpenSandboxWorkspace(sandbox, boundaries.sandboxConnector);
    const handle = { sandboxId: record.sandboxId, expiresAt: record.expiresAt };
    await workspace.connect(handle);
    try {
      const endpoint = await workspace.endpoint(handle, 4173);
      const response = await fetch(`${endpoint.url.replace(/\/$/, "")}/pivloom-revision.json`, {
        headers: endpoint.headers, signal: AbortSignal.timeout(5_000), redirect: "error",
      });
      if (!response.ok) throw new RuntimeError("ROLLBACK_MARKER_UNAVAILABLE", "回滚预览版本标识不可用。");
      const marker = await response.json() as { revisionId?: string; sourceHash?: string };
      if (marker.revisionId !== record.targetRevisionId || marker.sourceHash !== record.sourceHash)
        throw new RuntimeError("ROLLBACK_MARKER_MISMATCH", "回滚预览版本标识与目标不一致。");
      return endpoint;
    } finally {
      await workspace.releaseClient(handle).catch(() => {});
    }
  }

  async function cleanup(record: StoredRollback, code: string, message: string) {
    // Always read the durable row before killing: COMMIT may have succeeded
    // even when its response was lost at the network boundary.
    const fresh = await repository.get(record.ownerId, record.projectId, record.id);
    if (fresh.status === "committed") { claims.delete(fresh.id); return; }
    const failed = await repository.fail(fresh.ownerId, fresh.projectId, fresh.id, { code, message });
    if (failed.status === "committed") { claims.delete(failed.id); return; }
    if (!failed.sandboxId) { claims.delete(failed.id); return; }
    const destroyed = await destroyCandidateSandbox({ sandboxConfig: sandbox, sandboxId: failed.sandboxId,
      sandboxConnector: boundaries.sandboxConnector });
    if (!destroyed.confirmed) {
      claims.set(failed.id, { id: failed.id, ownerId: failed.ownerId, projectId: failed.projectId,
        sandboxId: failed.sandboxId, status: failed.status });
      return;
    }
    previews.revoke(failed.targetRevisionId, failed.sandboxId);
    await repository.markSandboxDestroyed(failed.ownerId, failed.projectId, failed.id, failed.sandboxId);
    claims.delete(failed.id);
  }

  async function reconcile(claim: StaleRollbackClaim) {
    if (reconciling.has(claim.id)) return reconciling.get(claim.id)!;
    const task = (async () => {
      const record = await repository.get(claim.ownerId, claim.projectId, claim.id);
      if (["committed", "failed", "cancelled"].includes(record.status)) { claims.delete(record.id); return; }
      if (record.status === "prepared" && record.sandboxId) {
        try {
          const endpoint = await verifiedEndpoint(record);
          previews.register({ ownerId: record.ownerId, projectId: record.projectId,
            revisionId: record.targetRevisionId, sandboxId: record.sandboxId,
            sourceHash: record.sourceHash, expiresAt: record.expiresAt!,
            upstreamUrl: endpoint.url, headers: endpoint.headers });
          const committed = await repository.commit(record.ownerId, record.projectId, record.id);
          if (committed.status === "committed") { retained.set(committed.id, committed); claims.delete(record.id); return; }
        } catch (error) {
          if (Date.parse(record.expiresAt ?? "") > Date.now()) throw error;
          // The prepared sandbox has expired. It cannot be the new current.
        }
      }
      await cleanup(record, record.error?.code ?? "SERVICE_RESTARTED",
        record.error?.message ?? "服务中断了回滚准备，旧版本保持不变。");
    })().finally(() => { reconciling.delete(claim.id); });
    reconciling.set(claim.id, task);
    return task;
  }

  async function execute(record: StoredRollback, controller: AbortController) {
    const timeout = setTimeout(() => controller.abort("ROLLBACK_TIMEOUT"), RESTORE_TIMEOUT_MS);
    let createdSandboxId: string | null = null;
    try {
      const revision = await generation.getRevision(record.ownerId, record.targetRevisionId);
      if (revision.projectId !== record.projectId || revision.status !== "accepted" || revision.sourceHash !== record.sourceHash)
        throw new RuntimeError("ROLLBACK_TARGET_MISMATCH", "回滚目标版本已失效。");
      const expected = sourceBundleFiles(await sources.load(revision.source));
      const result = await restorePreview({ revisionId: revision.id, sourceHash: record.sourceHash,
        templateVersion: revision.source.templateVersion,
        files: expected, sandboxConfig: sandbox, signal: controller.signal,
        async onSandbox(handle) {
          createdSandboxId = handle.sandboxId;
          await repository.registerSandbox(record.ownerId, record.projectId, record.id,
            { sandboxId: handle.sandboxId, expiresAt: handle.expiresAt });
        },
      }, boundaries);
      const expectedFiles = new Map(expected.map((file) => [file.path, file.sha256]));
      if (result.files.length !== expectedFiles.size || result.files.some((file) =>
        expectedFiles.get(file.path) !== file.sha256))
        throw new RuntimeError("ROLLBACK_FILE_MISMATCH", "重建后的完整文件集合与目标版本不同。");
      controller.signal.throwIfAborted();
      await repository.markPrepared(record.ownerId, record.projectId, record.id, {
        sandboxId: result.handle.sandboxId, sourceHash: result.sourceHash,
        markerVerified: true, filesVerified: true, writeRevoked: true,
      });
      // A crash here leaves a durable prepared checkpoint. Boot reconnects,
      // revalidates the marker, and commits or cleans up without model replay.
      previews.register({ ownerId: record.ownerId, projectId: record.projectId, revisionId: record.targetRevisionId,
        sandboxId: result.handle.sandboxId, sourceHash: record.sourceHash, expiresAt: result.handle.expiresAt,
        upstreamUrl: result.upstreamUrl, headers: result.headers });
      const committed = await repository.commit(record.ownerId, record.projectId, record.id);
      retained.set(committed.id, committed);
    } catch (error) {
      // If COMMIT succeeded but its acknowledgement disappeared, get() says
      // committed and cleanup must never destroy the new current preview.
      const fresh = await repository.get(record.ownerId, record.projectId, record.id).catch(() => null);
      if (fresh?.status === "committed") { retained.set(fresh.id, fresh); return; }
      if (createdSandboxId && fresh?.sandboxId !== createdSandboxId) {
        const orphan = createdSandboxId;
        const destroyed = await destroyCandidateSandbox({ sandboxConfig: sandbox, sandboxId: orphan,
          sandboxConnector: boundaries.sandboxConnector });
        if (!destroyed.confirmed) unregistered.add(orphan);
      }
      const code = controller.signal.reason === "ROLLBACK_TIMEOUT" ? "ROLLBACK_TIMEOUT"
        : controller.signal.aborted ? "CANCELLED"
          : error instanceof RuntimeError ? error.code : "ROLLBACK_FAILED";
      const message = code === "ROLLBACK_TIMEOUT" ? "回滚准备超时，旧版本保持不变。"
        : code === "CANCELLED" ? "回滚已取消，旧版本保持不变。"
          : error instanceof RuntimeError ? error.message.slice(0, 2000) : "回滚准备失败，旧版本保持不变。";
      if (!fresh || (fresh.status === "prepared" && !controller.signal.aborted)) {
        claims.set(record.id, { id: record.id, ownerId: record.ownerId, projectId: record.projectId,
          sandboxId: fresh?.sandboxId ?? null, status: fresh?.status ?? "preparing" });
      } else {
        await cleanup(fresh, code, message).catch(() => {
          claims.set(record.id, { id: record.id, ownerId: record.ownerId, projectId: record.projectId,
            sandboxId: fresh.sandboxId, status: fresh.status });
        });
      }
    } finally { clearTimeout(timeout); }
  }

  const timer = setInterval(() => {
    if (closing) return;
    for (const claim of claims.values()) if (!tasks.has(claim.id)) void reconcile(claim).catch(() => {});
    for (const record of retained.values()) if (Date.parse(record.expiresAt ?? "") <= Date.now())
      void cleanExpiredCommitted(record).catch(() => {});
    for (const sandboxId of unregistered) void destroyCandidateSandbox({ sandboxConfig: sandbox, sandboxId,
      sandboxConnector: boundaries.sandboxConnector })
      .then(({ confirmed }) => { if (confirmed) unregistered.delete(sandboxId); }).catch(() => {});
  }, 3_000);
  timer.unref();

  return {
    start(record: StoredRollback) {
      if (closing || tasks.has(record.id) || record.status !== "preparing") return;
      const controller = new AbortController();
      const done = execute(record, controller).finally(() => tasks.delete(record.id));
      tasks.set(record.id, { controller, done });
    },
    cancel(record: StoredRollback) {
      const task = tasks.get(record.id);
      if (task) { task.controller.abort("CANCELLED"); return; }
      claims.set(record.id, { id: record.id, ownerId: record.ownerId,
        projectId: record.projectId, sandboxId: record.sandboxId, status: record.status });
      void reconcile(claims.get(record.id)!).catch(() => {});
    },
    async recoverAtBoot() {
      const stale = await repository.claimStale();
      for (const claim of stale) claims.set(claim.id, claim);
      await Promise.allSettled(stale.map(reconcile));
      const active = await repository.committedActivePreviews();
      for (const item of active) {
        const record = await repository.get(item.ownerId, item.projectId, item.id);
        retained.set(record.id, record);
      }
      await Promise.allSettled([...retained.values()].map(cleanExpiredCommitted));
      return stale.length;
    },
    async retryClaims() { await Promise.allSettled([...claims.values()].map(reconcile)); },
    async rehydrate(record: StoredRollback) {
      if (record.status !== "committed" || !record.sandboxId) return;
      if (previews.get(record.ownerId, record.targetRevisionId)?.state === "ready") return;
      const endpoint = await verifiedEndpoint(record);
      if (previews.get(record.ownerId, record.targetRevisionId)?.state === "ready") return;
      previews.register({ ownerId: record.ownerId, projectId: record.projectId,
        revisionId: record.targetRevisionId, sandboxId: record.sandboxId,
        sourceHash: record.sourceHash, expiresAt: record.expiresAt!,
        upstreamUrl: endpoint.url, headers: endpoint.headers });
      retained.set(record.id, record);
    },
    async close() {
      closing = true;
      clearInterval(timer);
      for (const task of tasks.values()) task.controller.abort("SERVICE_RESTARTED");
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...tasks.values()].map((task) => task.done)),
        new Promise<void>((resolve) => { grace = setTimeout(resolve, 15_000); })]);
      clearTimeout(grace);
      await Promise.allSettled([...unregistered].map(async (sandboxId) => {
        if ((await destroyCandidateSandbox({ sandboxConfig: sandbox, sandboxId,
          sandboxConnector: boundaries.sandboxConnector })).confirmed) unregistered.delete(sandboxId);
      }));
    },
  };
}
