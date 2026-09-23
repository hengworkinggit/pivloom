import { RevisionDiffResponseSchema, VersionHistoryResponseSchema } from "@pivloom/contracts";
import type { ApiWorkspace } from "./api-workspace";

export function createVersionHistoryApi(api: Pick<ApiWorkspace, "request">) {
  return {
    list: async (projectId: string) => VersionHistoryResponseSchema.parse(
      await api.request(`/projects/${encodeURIComponent(projectId)}/revisions`)),
    compare: async (projectId: string, fromRevisionId: string, toRevisionId: string) => RevisionDiffResponseSchema.parse(
      await api.request(`/projects/${encodeURIComponent(projectId)}/revisions/diff?from=${encodeURIComponent(fromRevisionId)}&to=${encodeURIComponent(toRevisionId)}`)),
  };
}
export type VersionHistoryApi = ReturnType<typeof createVersionHistoryApi>;
