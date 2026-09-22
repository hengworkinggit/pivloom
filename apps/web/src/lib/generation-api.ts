import {
  CreateRunRequestSchema, CreateRunResponseSchema, RunDetailResponseSchema,
  RevisionFilesResponseSchema, RevisionFileResponseSchema, PreviewResponseSchema, RevisionCheckResponseSchema,
  CancelRunResponseSchema, RestorePreviewResponseSchema,
  type CreateRunRequest, type RunEvent, type ReviewArtifact,
} from "@pivloom/contracts";
import { WorkspaceError, type ApiWorkspace } from "./api-workspace";
import { readDraft, saveDraft } from "./drafts";
import { readRunEvents } from "./run-events";

export interface RunSubmission { key: string; body: CreateRunRequest }
const pendingKey = (projectId: string) => `pending-run:${projectId}`;

export function readPendingSubmission(ownerId: string, projectId: string): RunSubmission | null {
  try {
    const stored: unknown = JSON.parse(readDraft(ownerId, pendingKey(projectId)));
    if (!stored || typeof stored !== "object" || !("key" in stored) || !("body" in stored)
      || typeof stored.key !== "string" || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(stored.key)) return null;
    return { key: stored.key, body: CreateRunRequestSchema.parse(stored.body) };
  } catch { return null; }
}
export const savePendingSubmission = (ownerId: string, projectId: string, submission: RunSubmission) =>
  saveDraft(ownerId, pendingKey(projectId), JSON.stringify(submission));
export const clearPendingSubmission = (ownerId: string, projectId: string) => saveDraft(ownerId, pendingKey(projectId), "");

export function createGenerationApi(api: Pick<ApiWorkspace, "request" | "requestStream" | "requestBlob">) {
  return {
    start: async (projectId: string, submission: RunSubmission) => CreateRunResponseSchema.parse(await api.request(`/projects/${encodeURIComponent(projectId)}/runs`, {
      method: "POST", headers: { "Idempotency-Key": submission.key },
      body: JSON.stringify(CreateRunRequestSchema.parse(submission.body)),
    })),
    /** Idempotent stop request; the run leaves cancel_requested only once the
     * service has confirmed its remote model call and sandbox are gone. */
    cancel: async (runId: string) => CancelRunResponseSchema.parse(await api.request(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    })),
    /** Rebuilds a preview from saved source. It never calls a model. */
    restorePreview: async (projectId: string, revisionId: string) => RestorePreviewResponseSchema.parse(
      await api.request(`/projects/${encodeURIComponent(projectId)}/preview/restore`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ revisionId }),
      })),
    getRun: async (runId: string) => RunDetailResponseSchema.parse(await api.request(`/runs/${encodeURIComponent(runId)}`)),
    getCheck: async (revisionId: string) => {
      const result = RevisionCheckResponseSchema.safeParse(await api.request(`/revisions/${encodeURIComponent(revisionId)}/check`));
      if (!result.success) throw new WorkspaceError("INVALID_CHECK", "检查记录格式不正确，请重新读取。");
      return result.data.check;
    },
    getArtifact: async (checkId: string, artifact: ReviewArtifact, signal?: AbortSignal) => {
      const image = await api.requestBlob(`/checks/${encodeURIComponent(checkId)}/artifacts/${encodeURIComponent(artifact.id)}`, { signal });
      if (image.type !== "image/png" || image.size > 2 * 1024 * 1024) throw new Error("检查截图格式或大小不正确。");
      const bytes = await image.arrayBuffer();
      const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!pngHeader.every((value, index) => new Uint8Array(bytes)[index] === value)) throw new Error("检查截图格式不正确。");
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
      if (hash !== artifact.sha256) throw new Error("检查截图与已保存记录不一致，请重新加载。");
      return image;
    },
    getFiles: async (revisionId: string) => RevisionFilesResponseSchema.parse(await api.request(`/revisions/${encodeURIComponent(revisionId)}/files`)),
    getFile: async (revisionId: string, path: string) => RevisionFileResponseSchema.parse(await api.request(`/revisions/${encodeURIComponent(revisionId)}/file?path=${encodeURIComponent(path)}`)),
    getPreview: async (projectId: string, revisionId: string) => PreviewResponseSchema.parse(await api.request(`/projects/${encodeURIComponent(projectId)}/preview?revisionId=${encodeURIComponent(revisionId)}`)).preview,
    events: (runId: string, after: string, onEvent: (event: RunEvent) => void, signal: AbortSignal) =>
      api.requestStream(`/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}`,
        async (response, authSignal) => { await readRunEvents(response, { runId, after, onEvent, signal: authSignal }); },
        { signal, headers: { Accept: "text/event-stream" } }),
  };
}
export type GenerationApi = ReturnType<typeof createGenerationApi>;
