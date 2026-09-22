import { expect, it } from "vitest";
import { createModelsApi } from "./models-api";

it("keeps only the public masked profile when an API response accidentally contains a key", async () => {
  const boundary = {
    request: async () => ({ profile: {
      id: "d48d8527-9c46-465f-8a75-8be51d687157", name: "工作模型",
      provider: "openai-completions", baseUrl: "https://provider.example.test/v1", modelId: "model-a",
      apiKey: "fixture-secret-must-not-reach-ui", keyMask: "••••1234", configVersion: 1, isDefault: true,
      capabilities: { streaming: "unknown", tools: "unknown", vision: "unknown" }, lastTest: null,
      createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
    } }),
  };
  const api = createModelsApi(boundary);
  const saved = await api.create({ name: "工作模型", provider: "openai-completions", baseUrl: "https://provider.example.test/v1", modelId: "model-a", apiKey: "fixture-secret-must-not-reach-ui" });
  expect(saved.keyMask).toBe("••••1234");
  expect(saved).not.toHaveProperty("apiKey");
  expect(JSON.stringify(saved)).not.toContain("fixture-secret-must-not-reach-ui");
});
