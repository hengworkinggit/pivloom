import {
  RevisionCheckResponseSchema, ProjectDetailResponseSchema, RunDetailResponseSchema, RevisionFileResponseSchema,
  RevisionFilesResponseSchema, TerminalRunStates, RestorePreviewResponseSchema,
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
import { ApiFailure } from "../routes/errors.js";
import { createGenerationExecutor } from "./executor.js";
import { destroyCandidateSandbox } from "./candidate.js";
import { createPreviewGateway } from "./preview.js";
import { createRunEventHub, openRunEventStream, type RunEventLimits } from "./events.js";
import { createPublicationStore } from "./publication.js";

export function createGenerationService(options: {
  database: PivloomDatabase; models: ModelProfileService; identity: IdentityConfig;
  sandbox: SandboxConfig; previewOrigin: string; bootId: string; maxSandboxes: number;
  dailyLimitByOwner?: Readonly<Record<string, number>>;
  generationBoundaries?: Parameters<typeof createGenerationExecutor>[1];
  sourceObjects?: SourceObjectStore;
  artifactObjects?: ArtifactObjects;
  eventLimits?: RunEventLimits;
  publishedRoot?: string; publishedBaseUrl?: string;
}) {
  const projects = createProjectRepository(options.database);
  const eventHub = createRunEventHub();
  const repository = createGenerationRepository(options.database, options.models, {
    executorBootId: options.bootId, maxSandboxes: options.maxSandboxes,
    dailyLimitByOwner: options.dailyLimitByOwner,
    onCommittedEvent: eventHub.publish,
  });
  const sources = createSourceStore({ url: options.identity.supabaseUrl, secret: options.identity.supabaseSecretKey, objects: options.sourceObjects });
  const artifacts = createArtifactStore({ url: options.identity.supabaseUrl, secret: options.identity.supabaseSecretKey, objects: options.artifactObjects });
  const previews = createPreviewGateway({ publicOrigin: options.previewOrigin, appOrigin: options.identity.appOrigin, sandboxOrigin: options.sandbox.baseUrl });
  const executor = createGenerationExecutor({ repository, models: options.models, sources, artifacts, previews, sandbox: options.sandbox, maxSandboxes: options.maxSandboxes }, options.generationBoundaries);
  const publications = options.publishedBaseUrl ? createPublicationStore({
    root: options.publishedRoot ?? "/opt/pivloom/published", baseUrl: options.publishedBaseUrl, sandbox: options.sandbox,
  }) : null;

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

  async function preview(ownerId: string, projectId: string, revisionId?: string): Promise<Preview | null> {
    const project = await projects.get(ownerId, projectId);
    const selected = revisionId ?? project.currentRevisionId;
    if (!selected) return null;
    const revision = await repository.getRevision(ownerId, selected);
    if (revision.projectId !== projectId) throw new ApiFailure(404, "NOT_FOUND", "找不到这个项目资源。");
    return previewView(ownerId, revision, await repository.getPreviewBinding(ownerId, projectId, selected),
      await repository.getActiveRestore(ownerId, projectId, selected));
  }

  /** Boot-time reconciliation: no run from a previous process may stay "active". */
  async function recover() {
    const claim = await options.database.system(async (client) => client.query<{
      o_run_id: string; o_owner_id: string; o_project_id: string; o_sandbox_ids: string[] | null;
    }>("SELECT * FROM nano.claim_stale_runs($1)", [options.bootId]));
    for (const row of claim.rows) {
      let confirmed = true;
      for (const sandboxId of row.o_sandbox_ids ?? []) {
        const destroyed = await destroyCandidateSandbox({ sandboxConfig: options.sandbox, sandboxId }).catch(() => ({ confirmed: false }));
        if (!destroyed.confirmed) confirmed = false;
      }
      if (confirmed)
        await options.database.system(async (client) => { await client.query("SELECT nano.settle_recovered_run($1,$2)", [row.o_owner_id, row.o_run_id]); }).catch(() => undefined);
    }
    const restores = await options.database.system(async (client) => client.query<{
      o_restore_id: string; o_owner_id: string; o_project_id: string; o_sandbox_id: string;
    }>("SELECT * FROM nano.claim_stale_restores()"));
    for (const row of restores.rows) {
      const destroyed = await destroyCandidateSandbox({ sandboxConfig: options.sandbox, sandboxId: row.o_sandbox_id }).catch(() => ({ confirmed: false }));
      if (destroyed.confirmed)
        await repository.markRestoreSandboxDestroyed(row.o_owner_id, row.o_project_id, row.o_restore_id, row.o_sandbox_id);
    }
    // Restores interrupted before the remote ID was registered have no known
    // sandbox to kill; the short remote creation TTL bounds that crash window.
    await options.database.system(async (client) => { await client.query("SELECT nano.recover_stale_restores()"); });
    return claim.rows.length;
  }

  return {
    repository,
    previews,
    recover,
    openEvents(ownerId: string, runId: string, after: string, signal: AbortSignal) {
      return openRunEventStream(repository, eventHub, { ownerId, runId, after, signal }, options.eventLimits);
    },
    async accept(ownerId: string, projectId: string, input: CreateRunRequest, idempotencyKey: string) {
      return repository.accept(ownerId, projectId, { ...input, idempotencyKey });
    },
    start(run: StoredRun) { executor.start(run); },
    async projectDetail(ownerId: string, projectId: string) {
      const { project, messages, latestRun, currentRevision, latestCandidate, binding } = await repository.readProjectSnapshot(ownerId, projectId);
      const selected = latestCandidate ?? currentRevision;
      const quota = await repository.quota(ownerId);
      return ProjectDetailResponseSchema.parse({ project, messages, latestRun, currentRevision, latestCandidate,
        latestCheck: selected ? await repository.getRunCheck(ownerId, selected.runId) : null,
        activeRun: latestRun && (!TerminalRunStates.has(latestRun.state) || latestRun.cleanupState === "pending") ? latestRun : null,
        preview: selected ? previewView(ownerId, selected, binding, await repository.getActiveRestore(ownerId, projectId, selected.id)) : null,
        quota });
    },
    async runDetail(ownerId: string, runId: string) {
      const { run, revision, events, binding, roles } = await repository.readRunSnapshot(ownerId, runId);
      return RunDetailResponseSchema.parse({ run, revision, events, roles,
        preview: revision ? previewView(ownerId, revision, binding) : null });
    },
    preview,
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
      if (cancelled.state === "cancel_requested" && !executor.cancel(runId))
        return repository.finishCancelled(ownerId, runId, { cleanupState: "confirmed", summary: "任务已停止。" });
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
    async close() { await executor.close(); await previews.close(); },
  };
}
export type GenerationService = ReturnType<typeof createGenerationService>;
