import {
  RevisionCheckResponseSchema, ProjectDetailResponseSchema, RunDetailResponseSchema, RevisionFileResponseSchema,
  RevisionFilesResponseSchema, TerminalRunStates, RestorePreviewResponseSchema, RollbackResponseSchema,
  type Preview, type CreateRunRequest,
} from "@pivloom/contracts";
import type { PivloomDatabase } from "../data/database.js";
import { createProjectRepository } from "../data/projects.js";
import {
  createGenerationRepository, type StoredRestore, type StoredRun, type StoredRevision, type StoredSandboxBinding,
} from "../data/generation.js";
import type { ModelProfileService } from "../models/service.js";
import { createSourceStore, type SourceObjectStore } from "../storage/source.js";
import { createArtifactStore, type ArtifactObjects } from "../storage/artifacts.js";
import type { IdentityConfig } from "../config/identity.js";
import type { SandboxConfig } from "../runtime/types.js";
import { ApiFailure, unauthenticated } from "../routes/errors.js";
import { createGenerationExecutor } from "./executor.js";
import { createRollbackRepository } from "../data/rollback.js";
import { createRollbackExecutor } from "./rollback.js";
import { destroyCandidateSandbox } from "./candidate.js";
import { createPreviewGateway } from "./preview.js";
import { createRunEventHub, openRunEventStream, type RunEventLimits } from "./events.js";
import { createPublicationStore } from "./publication.js";
import { createGenerationScheduler } from "./scheduler.js";

export function createGenerationService(options: {
  database: PivloomDatabase; models: ModelProfileService; identity: IdentityConfig;
  sessionDatabase?: PivloomDatabase;
  sandbox: SandboxConfig; previewOrigin: string; bootId: string; maxSandboxes: number;
  dailyLimitByOwner?: Readonly<Record<string, number>>;
  generationBoundaries?: Parameters<typeof createGenerationExecutor>[1];
  sourceObjects?: SourceObjectStore;
  artifactObjects?: ArtifactObjects;
  eventLimits?: RunEventLimits;
  publishedRoot?: string; publishedBaseUrl?: string;
  recoverySweepMs?: number;
}) {
  const projects = createProjectRepository(options.database);
  const eventHub = createRunEventHub();
  const repository = createGenerationRepository(options.database, options.models, {
    executorBootId: options.bootId, maxSandboxes: options.maxSandboxes,
    dailyLimitByOwner: options.dailyLimitByOwner,
    onCommittedEvent: eventHub.publish,
  });
  const rollbacks = createRollbackRepository(options.database, { maxSandboxes: options.maxSandboxes });
  const sources = createSourceStore({ url: options.identity.supabaseUrl, secret: options.identity.supabaseSecretKey, objects: options.sourceObjects });
  const artifacts = createArtifactStore({ url: options.identity.supabaseUrl, secret: options.identity.supabaseSecretKey, objects: options.artifactObjects });
  const previews = createPreviewGateway({ publicOrigin: options.previewOrigin, appOrigin: options.identity.appOrigin,
    sandboxOrigin: options.sandbox.baseUrl,
    isSessionActive: async (ownerId, sessionId) => (options.sessionDatabase ?? options.database).system(async (client) => {
      const result = await client.query<{ active: boolean }>("SELECT nano.preview_session_active($1::uuid, $2::uuid) AS active", [ownerId, sessionId]);
      return result.rows[0]?.active === true;
    }),
  });
  // Settling a run frees its capacity slot, so the queue is woken as soon as the
  // executor stops owning the run. The scheduler only looks; the durable queue
  // and nano.claim_next_queued_run decide what may start.
  let wakeQueue: () => void = () => {};
  const executor = createGenerationExecutor({ repository, models: options.models, sources, artifacts, previews,
    sandbox: options.sandbox, maxSandboxes: options.maxSandboxes, onTaskSettled: () => wakeQueue() }, options.generationBoundaries);
  const scheduler = createGenerationScheduler({ repository, start: (run) => executor.start(run) });
  wakeQueue = () => scheduler.wake();
  const rollbackExecutor = createRollbackExecutor({ repository: rollbacks, generation: repository, sources, previews,
    sandbox: options.sandbox }, options.generationBoundaries);
  const publications = options.publishedBaseUrl ? createPublicationStore({
    root: options.publishedRoot ?? "/opt/pivloom/published", baseUrl: options.publishedBaseUrl, sandbox: options.sandbox,
  }) : null;
  let closing = false;
  let recovering: Promise<number> | undefined;
  const bootRestoreClaims = new Map<string, { ownerId: string; projectId: string; sandboxId: string }>();
  let bootRestoreScanComplete = false;
  let bootRollbackScanComplete = false;
  const recoverySweepMs = options.recoverySweepMs ?? 30_000;
  if (!Number.isInteger(recoverySweepMs) || recoverySweepMs < 1) throw new Error("Recovery sweep interval must be positive");

  function previewView(ownerId: string, revision: StoredRevision, binding: StoredSandboxBinding | null, restore: StoredRestore | null = null): Preview {
    const live = previews.get(ownerId, revision.id);
    if (binding?.state === "active" && binding.sourceHash === revision.sourceHash && live?.sourceHash === revision.sourceHash) return live;
    // A restore in flight is a distinct state: the source is safe, the preview
    // is being rebuilt, and no model call is involved.
    if (restore?.status === "pending")
      return { state: "restoring", revisionId: revision.id, sourceHash: revision.sourceHash, url: null, expiresAt: null,
        error: restore.error ? "预览恢复未完成，远端清理待确认；源码仍已保存，确认回收后可以重试。"
          : "正在从已保存的源码重建预览，不会调用模型。" };
    const expired = binding && (binding.state === "expired" || binding.state === "destroyed" || Date.parse(binding.expiresAt) <= Date.now());
    const failure = restore?.status === "failed" ? restore.error : null;
    return { state: expired ? "expired" : "unavailable", revisionId: revision.id, sourceHash: revision.sourceHash,
      url: null, expiresAt: binding?.expiresAt ?? null,
      error: expired ? "预览已到期，源码仍已保存，可以重新启动预览。" : revision.buildStatus === "failed" ? "构建未通过，可查看已保存源码和错误。"
        : failure?.message ?? "预览暂时不可用，源码仍已保存。" };
  }

  async function rehydrateRollbackPreview(ownerId: string, projectId: string, revisionId: string, binding: StoredSandboxBinding | null) {
    if (!binding || binding.state !== "active" || previews.get(ownerId, revisionId)?.state === "ready") return;
    const committed = await rollbacks.committedForBinding(ownerId, projectId, revisionId, binding.sandboxId);
    if (committed) await rollbackExecutor.rehydrate(committed).catch(() => {});
  }

  async function preview(ownerId: string, projectId: string, revisionId?: string): Promise<Preview | null> {
    const project = await projects.get(ownerId, projectId);
    const selected = revisionId ?? project.currentRevisionId;
    if (!selected) return null;
    const revision = await repository.getRevision(ownerId, selected);
    if (revision.projectId !== projectId) throw new ApiFailure(404, "NOT_FOUND", "找不到这个项目资源。");
    const binding = await repository.getPreviewBinding(ownerId, projectId, selected);
    await rehydrateRollbackPreview(ownerId, projectId, selected, binding);
    return previewView(ownerId, revision, binding, await repository.getActiveRestore(ownerId, projectId, selected));
  }

  async function retryBootRestoreClaims() {
    for (const [restoreId, claim] of bootRestoreClaims) {
      const destroyed = await destroyCandidateSandbox({ sandboxConfig: options.sandbox, sandboxId: claim.sandboxId })
        .catch(() => ({ confirmed: false }));
      if (!destroyed.confirmed) continue;
      const marked = await repository.markRestoreSandboxDestroyed(claim.ownerId, claim.projectId, restoreId, claim.sandboxId)
        .then(() => true, () => false);
      if (marked) bootRestoreClaims.delete(restoreId);
    }
  }

  /** Boot claims stale restores once. Later sweeps only retry those exact IDs;
   * a global scan after listen would kill this process's live restore. */
  async function recoverOnce() {
    const claim = await options.database.system(async (client) => client.query<{
      o_run_id: string; o_owner_id: string; o_project_id: string; o_sandbox_ids: string[] | null;
    }>("SELECT * FROM nano.claim_stale_runs($1)", [options.bootId]));
    for (const row of claim.rows) {
      let confirmed = true;
      for (const sandboxId of row.o_sandbox_ids ?? []) {
        const destroyed = await destroyCandidateSandbox({ sandboxConfig: options.sandbox, sandboxId,
          sandboxConnector: options.generationBoundaries?.sandboxConnector }).catch(() => ({ confirmed: false }));
        if (!destroyed.confirmed) confirmed = false;
      }
      if (confirmed)
        await options.database.system(async (client) => { await client.query("SELECT nano.settle_recovered_run($1,$2)", [row.o_owner_id, row.o_run_id]); }).catch(() => undefined);
    }
    if (!bootRestoreScanComplete) {
      const restores = await options.database.system(async (client) => client.query<{
        o_restore_id: string; o_owner_id: string; o_project_id: string; o_sandbox_id: string;
      }>("SELECT * FROM nano.claim_stale_restores()"));
      for (const row of restores.rows) bootRestoreClaims.set(row.o_restore_id, {
        ownerId: row.o_owner_id, projectId: row.o_project_id, sandboxId: row.o_sandbox_id,
      });
      await retryBootRestoreClaims();
      // Pending restores without a registered sandbox can only be classified
      // at boot. Running this again after listen would race a new remote create.
      await options.database.system(async (client) => { await client.query("SELECT nano.recover_stale_restores()"); });
      bootRestoreScanComplete = true;
    } else {
      await retryBootRestoreClaims();
    }
    if (!bootRollbackScanComplete) {
      await rollbackExecutor.recoverAtBoot();
      bootRollbackScanComplete = true;
    } else {
      await rollbackExecutor.retryClaims();
    }
    return claim.rows.length;
  }

  function recover(): Promise<number> {
    if (recovering) return recovering;
    recovering = recoverOnce().finally(() => { recovering = undefined; });
    return recovering;
  }

  // A remote kill or final DB write can fail during boot reconciliation. Keep
  // retrying the same durable claims while this process is alive, not only on
  // the next deployment/restart.
  const recoveryTimer = setInterval(() => {
    if (closing || !bootRestoreScanComplete) return;
    void recover().catch((error) => {
      const reason = error instanceof Error ? error.name : "unknown";
      console.error(`stale resource reconciliation is pending (${reason})`);
    });
  }, recoverySweepMs);
  recoveryTimer.unref();

  return {
    repository,
    rollbacks,
    previews,
    recover,
    openEvents(ownerId: string, runId: string, after: string, signal: AbortSignal) {
      return openRunEventStream(repository, eventHub, { ownerId, runId, after, signal }, options.eventLimits);
    },
    async accept(ownerId: string, projectId: string, input: CreateRunRequest, idempotencyKey: string) {
      return repository.accept(ownerId, projectId, { ...input, idempotencyKey });
    },
    start(run: StoredRun) { executor.start(run); },
    /** Dispatches persisted queued tasks as capacity frees up. */
    wake() { scheduler.wake(); },
    /** Begins dispatch after boot recovery; safe to call more than once. */
    startQueue() { scheduler.start(); },
    tasks(ownerId: string) { return repository.listTasks(ownerId); },
    async projectDetail(ownerId: string, projectId: string) {
      const { project, messages, latestRun, currentRevision, latestCandidate, binding, lastRollbackAt } = await repository.readProjectSnapshot(ownerId, projectId);
      const selected = latestCandidate && (!lastRollbackAt || Date.parse(latestCandidate.createdAt) > Date.parse(lastRollbackAt))
        ? latestCandidate : currentRevision ?? latestCandidate;
      const visibleCandidate = selected?.id === latestCandidate?.id ? latestCandidate : null;
      // Earlier Runs remain in history, but an old v3 Run cannot be the live
      // conversational baseline after the project has switched back to v1.
      const visibleLatestRun = latestRun && (!lastRollbackAt || Date.parse(latestRun.createdAt) >= Date.parse(lastRollbackAt))
        ? latestRun : null;
      const selectedBinding = selected && binding?.revisionId !== selected.id
        ? await repository.getPreviewBinding(ownerId, projectId, selected.id) : binding;
      if (selected) await rehydrateRollbackPreview(ownerId, projectId, selected.id, selectedBinding);
      const quota = await repository.quota(ownerId);
      const latestCheck = selected ? await repository.getRunCheck(ownerId, selected.runId) : null;
      return ProjectDetailResponseSchema.parse({ project, messages, latestRun: visibleLatestRun, currentRevision, latestCandidate: visibleCandidate,
        latestCheck, latestCheckHistorical: Boolean(latestCheck && lastRollbackAt
          && Date.parse(latestCheck.createdAt) <= Date.parse(lastRollbackAt) && selected?.id === currentRevision?.id),
        activeRun: visibleLatestRun && (!TerminalRunStates.has(visibleLatestRun.state) || visibleLatestRun.cleanupState === "pending") ? visibleLatestRun : null,
        preview: selected ? previewView(ownerId, selected, selectedBinding, await repository.getActiveRestore(ownerId, projectId, selected.id)) : null,
        quota });
    },
    async runDetail(ownerId: string, runId: string) {
      const { run, revision, events, binding, roles } = await repository.readRunSnapshot(ownerId, runId);
      if (revision) await rehydrateRollbackPreview(ownerId, revision.projectId, revision.id, binding);
      return RunDetailResponseSchema.parse({ run, revision, events, roles,
        preview: revision ? previewView(ownerId, revision, binding) : null });
    },
    preview,
    async previewAccess(ownerId: string, projectId: string, revisionId: string, sessionId: string) {
      const selected = await preview(ownerId, projectId, revisionId);
      if (!selected || selected.state !== "ready" || !selected.url)
        throw new ApiFailure(404, "PREVIEW_UNAVAILABLE", "预览暂时不可用，请重新启动预览。");
      const grant = await previews.issueGrant(ownerId, revisionId, sessionId);
      if (!grant) throw unauthenticated();
      return { url: selected.url, grant, revisionId };
    },
    /**
     * Authorises one certificate request for a revision subdomain. Any other
     * host is refused, so a public proxy can never be talked into issuing a
     * certificate for a name this service does not serve.
     */
    async previewHostAllowed(host: string) {
      const suffix = `.${new URL(options.previewOrigin).hostname.toLowerCase()}`;
      const name = host.trim().toLowerCase().replace(/\.$/, "");
      if (!name.endsWith(suffix)) return false;
      const label = name.slice(0, -suffix.length);
      if (label.includes(".") || label.length === 0) return false;
      return repository.revisionExists(label);
    },
    publishedHostAllowed(host: string) { return publications?.hostAllowed(host) ?? Promise.resolve(false); },
    publishedFile(host: string, path: string) { return publications?.publicFile(host, path) ?? Promise.resolve(null); },
    async publication(ownerId: string, projectId: string) {
      await projects.get(ownerId, projectId);
      return { publication: publications ? await publications.get(projectId) : null };
    },
    async publish(ownerId: string, projectId: string) {
      if (!publications) throw new ApiFailure(503, "PUBLICATION_UNAVAILABLE", "永久发布尚未配置。");
      const project = await projects.get(ownerId, projectId);
      if (!project.currentRevisionId) throw new ApiFailure(409, "NO_ACCEPTED_REVISION", "项目尚无通过检查的版本。");
      const revision = await repository.getRevision(ownerId, project.currentRevisionId);
      const check = await repository.getRunCheck(ownerId, revision.runId);
      if (revision.status !== "accepted" || revision.buildStatus !== "passed"
        || check?.verdict !== "passed" || check.revisionId !== revision.id || check.sourceHash !== revision.sourceHash)
        throw new ApiFailure(409, "REVISION_NOT_VERIFIED", "当前版本尚未通过检查，不能发布。");
      const existing = await publications.get(projectId);
      if (existing?.revisionId === revision.id && existing.sourceHash === revision.sourceHash) return { publication: existing };
      const binding = await repository.getPreviewBinding(ownerId, projectId, revision.id);
      if (!binding || binding.state !== "active" || binding.sourceHash !== revision.sourceHash
        || Date.parse(binding.expiresAt) <= Date.now())
        throw new ApiFailure(409, "PREVIEW_NOT_READY", "发布前请重新启动当前版本的预览。");
      return { publication: await publications.publish({ projectId, revisionId: revision.id,
        sourceHash: revision.sourceHash, sandboxId: binding.sandboxId }) };
    },
    async cancel(ownerId: string, runId: string) {
      const cancelled = await repository.cancel(ownerId, runId);
      // A run with no live task in this process (accepted but not yet dispatched,
      // or left behind by a restart) settles immediately instead of hanging.
      if (cancelled.state === "cancel_requested" && !executor.cancel(runId)) {
        const settled = await repository.finishCancelled(ownerId, runId, { cleanupState: "confirmed", summary: "任务已停止。" });
        // Releasing a slot is what the next waiting task needs; a stop that
        // frees capacity has to wake the queue instead of waiting for the sweep.
        wakeQueue();
        return settled;
      }
      if (TerminalRunStates.has(cancelled.state)) wakeQueue();
      return cancelled;
    },
    async restorePreview(ownerId: string, projectId: string, input: { revisionId: string; idempotencyKey: string }) {
      const { restore, revision, replayed } = await repository.beginRestore(ownerId, projectId, input);
      // A replayed key returns the already stored result; a key-less retry after
      // the sandbox expired must be a new request so cost is never silent.
      if (!replayed && restore.status === "pending") void executor.restore(restore, revision);
      const binding = await repository.getPreviewBinding(ownerId, projectId, revision.id);
      return RestorePreviewResponseSchema.parse({ operationId: restore.id,
        preview: previewView(ownerId, revision, binding, restore) });
    },
    async rollback(ownerId: string, projectId: string, input: {
      targetRevisionId: string; expectedCurrentRevisionId: string; idempotencyKey: string;
    }) {
      const accepted = await rollbacks.begin(ownerId, projectId, input);
      if (!accepted.replayed) rollbackExecutor.start(accepted.operation);
      return RollbackResponseSchema.parse(accepted);
    },
    async rollbackStatus(ownerId: string, projectId: string, operationId: string) {
      return RollbackResponseSchema.parse({ operation: await rollbacks.get(ownerId, projectId, operationId), replayed: true });
    },
    async cancelRollback(ownerId: string, projectId: string, operationId: string) {
      const operation = await rollbacks.cancel(ownerId, projectId, operationId);
      if (operation.status === "cancel_requested") rollbackExecutor.cancel(operation);
      return RollbackResponseSchema.parse({ operation, replayed: true });
    },
    async check(ownerId: string, revisionId: string) {
      const revision = await repository.getRevision(ownerId, revisionId);
      const check = await repository.getRunCheck(ownerId, revision.runId);
      return RevisionCheckResponseSchema.parse({ check: check?.revisionId === revisionId ? check : null });
    },
    async artifact(ownerId: string, checkId: string, artifactId: string) {
      const stored = await repository.getArtifact(ownerId, artifactId);
      if (stored.checkId !== checkId) throw new ApiFailure(404, "NOT_FOUND", "找不到这个检查截图。");
      return artifacts.load(stored.source, stored.artifact);
    },
    async files(ownerId: string, revisionId: string) {
      const revision = await repository.getRevision(ownerId, revisionId);
      return RevisionFilesResponseSchema.parse({ revisionId, sourceHash: revision.sourceHash, files: revision.manifest });
    },
    async file(ownerId: string, revisionId: string, path: string) {
      const revision = await repository.getRevision(ownerId, revisionId);
      if (!revision.manifest.some((file) => file.path === path)) throw new ApiFailure(404, "NOT_FOUND", "找不到这个源文件。");
      const bundle = await sources.load(revision.source);
      const file = bundle.files.find((file) => file.path === path);
      if (!file) throw new ApiFailure(503, "SNAPSHOT_UNAVAILABLE", "源码快照暂时无法读取。", true);
      return RevisionFileResponseSchema.parse({ revisionId, path, content: file.content, sha256: file.sha256 });
    },
    async close() {
      closing = true;
      clearInterval(recoveryTimer);
      await recovering?.catch(() => {});
      await scheduler.close();
      await executor.close();
      await rollbackExecutor.close();
      await previews.close();
    },
  };
}
export type GenerationService = ReturnType<typeof createGenerationService>;
