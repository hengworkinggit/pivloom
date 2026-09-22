import {
  CreateModelProfileSchema, UpdateModelProfileSchema, ModelProfileResponseSchema,
  ModelProfilesResponseSchema, ModelTestResultSchema,
  type CreateModelProfile, type UpdateModelProfile,
} from "@pivloom/contracts";

export function createModelsApi(api: { request(path: string, init?: RequestInit): Promise<unknown> }) {
  return {
    list: async () => ModelProfilesResponseSchema.parse(await api.request("/model-profiles")).profiles,
    create: async (input: CreateModelProfile) => ModelProfileResponseSchema.parse(await api.request("/model-profiles", {
      method: "POST", body: JSON.stringify(CreateModelProfileSchema.parse(input)),
    })).profile,
    update: async (id: string, input: UpdateModelProfile) => ModelProfileResponseSchema.parse(await api.request(`/model-profiles/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify(UpdateModelProfileSchema.parse(input)),
    })).profile,
    remove: async (id: string) => { await api.request(`/model-profiles/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    testDraft: async (input: CreateModelProfile) => ModelTestResultSchema.parse(await api.request("/model-profiles/test", {
      method: "POST", body: JSON.stringify(CreateModelProfileSchema.parse(input)),
    })),
    testSaved: async (id: string) => ModelTestResultSchema.parse(await api.request(`/model-profiles/${encodeURIComponent(id)}/test`, { method: "POST" })),
  };
}
export type ModelsApi = ReturnType<typeof createModelsApi>;
