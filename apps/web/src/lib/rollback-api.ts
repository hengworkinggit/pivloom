import { RollbackRequestSchema, RollbackResponseSchema, type RollbackRequest } from "@pivloom/contracts";
import type { ApiWorkspace } from "./api-workspace";

export function createRollbackApi(api: Pick<ApiWorkspace, "request">) {
  return {
    start: async (projectId: string, body: RollbackRequest, idempotencyKey: string) => RollbackResponseSchema.parse(
      await api.request(`/projects/${encodeURIComponent(projectId)}/rollback`, {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(RollbackRequestSchema.parse(body)),
      })),
    status: async (projectId: string, operationId: string) => RollbackResponseSchema.parse(
      await api.request(`/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(operationId)}`)),
    cancel: async (projectId: string, operationId: string) => RollbackResponseSchema.parse(
      await api.request(`/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(operationId)}/cancel`, { method: "POST" })),
  };
}

export type RollbackApi = ReturnType<typeof createRollbackApi>;
