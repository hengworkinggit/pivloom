import {
  CreateRunRequestSchema, CreateRunResponseSchema, RunDetailResponseSchema,
  RevisionFilesResponseSchema, RevisionFileResponseSchema, PreviewResponseSchema,
  type CreateRunRequest, type RunEvent,
} from "@pivloom/contracts";
import type { ApiWorkspace } from "./api-workspace";
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

export function createGenerationApi(api: Pick<ApiWorkspace, "request" | "requestStream">) {
  return {
    start: async (projectId: string, submission: RunSubmission) => CreateRunResponseSchema.parse(await api.request(`/projects/${encodeURIComponent(projectId)}/runs`, {
      method: "POST", headers: { "Idempotency-Key": submission.key },
      body: JSON.stringify(CreateRunRequestSchema.parse(submission.body)),
    })),
    getRun: async (runId: string) => RunDetailResponseSchema.parse(await api.request(`/runs/${encodeURIComponent(runId)}`)),
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
