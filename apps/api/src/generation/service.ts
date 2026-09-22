import {
  ProjectDetailResponseSchema, RunDetailResponseSchema, RevisionFileResponseSchema,
  RevisionFilesResponseSchema, TerminalRunStates, type Preview, type CreateRunRequest,
} from "@pivloom/contracts";
import type { PivloomDatabase } from "../data/database.js";
import { createProjectRepository } from "../data/projects.js";
import { createGenerationRepository, type StoredRun, type StoredRevision, type StoredSandboxBinding } from "../data/generation.js";
import type { ModelProfileService } from "../models/service.js";
import { createSourceStore, type SourceObjectStore } from "../storage/source.js";
import type { IdentityConfig } from "../config/identity.js";
import type { SandboxConfig } from "../runtime/types.js";
import { ApiFailure } from "../routes/errors.js";
import { createGenerationExecutor } from "./executor.js";
import { createPreviewGateway } from "./preview.js";
import { createRunEventHub, openRunEventStream, type RunEventLimits } from "./events.js";

export function createGenerationService(options: {
  database: PivloomDatabase; models: ModelProfileService; identity: IdentityConfig;
  sandbox: SandboxConfig; previewOrigin: string; bootId: string; maxSandboxes: number;
  sourceObjects?: SourceObjectStore;
  eventLimits?: RunEventLimits;
}) {
  const projects = createProjectRepository(options.database);
  const eventHub = createRunEventHub();
  const repository = createGenerationRepository(options.database, options.models, {
    executorBootId: options.bootId, hasSandboxCapacity: () => executor.hasCapacity(),
    onCommittedEvent: eventHub.publish,
  });
  const sources = createSourceStore({ url: options.identity.supabaseUrl, secret: options.identity.supabaseSecretKey, objects: options.sourceObjects });
  const previews = createPreviewGateway({ publicOrigin: options.previewOrigin, appOrigin: options.identity.appOrigin, sandboxOrigin: options.sandbox.baseUrl });
  const executor = createGenerationExecutor({ repository, models: options.models, sources, previews, sandbox: options.sandbox, maxSandboxes: options.maxSandboxes });

  function previewView(ownerId: string, revision: StoredRevision, binding: StoredSandboxBinding | null): Preview {
    const live = previews.get(ownerId, revision.id);
    if (binding?.state === "active" && binding.sourceHash === revision.sourceHash && live?.sourceHash === revision.sourceHash) return live;
    const expired = binding && (binding.state === "expired" || binding.state === "destroyed" || Date.parse(binding.expiresAt) <= Date.now());
    return { state: expired ? "expired" : "unavailable", revisionId: revision.id, sourceHash: revision.sourceHash,
      url: null, expiresAt: binding?.expiresAt ?? null,
      error: expired ? "预览已到期，源码仍已保存。" : revision.buildStatus === "failed" ? "构建未通过，可查看已保存源码和错误。" : "预览暂时不可用，源码仍已保存。" };
  }

  async function preview(ownerId: string, projectId: string, revisionId?: string): Promise<Preview | null> {
    const project = await projects.get(ownerId, projectId);
    const selected = revisionId ?? project.currentRevisionId;
    if (!selected) return null;
    const revision = await repository.getRevision(ownerId, selected);
    if (revision.projectId !== projectId) throw new ApiFailure(404, "NOT_FOUND", "找不到这个项目资源。");
    return previewView(ownerId, revision, await repository.getPreviewBinding(ownerId, projectId, selected));
  }

  return {
    repository,
    previews,
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
      return ProjectDetailResponseSchema.parse({ project, messages, latestRun, currentRevision, latestCandidate,
        activeRun: latestRun && (!TerminalRunStates.has(latestRun.state) || latestRun.cleanupState === "pending") ? latestRun : null,
        preview: selected ? previewView(ownerId, selected, binding) : null });
    },
    async runDetail(ownerId: string, runId: string) {
      const { run, revision, events, binding } = await repository.readRunSnapshot(ownerId, runId);
      return RunDetailResponseSchema.parse({ run, revision, events,
        preview: revision ? previewView(ownerId, revision, binding) : null });
    },
    preview,
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
