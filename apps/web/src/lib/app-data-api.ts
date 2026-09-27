import { z } from "zod";
import { AppRecordSchema, AppRecordsResponseSchema } from "@pivloom/contracts";
import type { ApiWorkspace } from "./api-workspace";

export function createAppDataApi(workspace: ApiWorkspace) {
  const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/app-data`;
  return {
    ownerAccess: async (projectId: string) => z.object({ url: z.url(), grant: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await workspace.request(`${base(projectId)}/access`, { method: "POST" })),
    list: async (projectId: string, offset = 0) => AppRecordsResponseSchema
      .parse(await workspace.request(`${base(projectId)}/records?offset=${offset}&limit=50`)),
    setConfirmed: async (projectId: string, recordId: string, confirmed: boolean) => z.object({ record: AppRecordSchema })
      .parse(await workspace.request(`${base(projectId)}/records/${encodeURIComponent(recordId)}`, {
        method: "PATCH", body: JSON.stringify({ confirmed }),
      })).record,
    remove: async (projectId: string, recordId: string) => {
      await workspace.request(`${base(projectId)}/records/${encodeURIComponent(recordId)}`, { method: "DELETE" });
    },
    export: (projectId: string) => workspace.requestBlob(`${base(projectId)}/export`),
  };
}
