import { expect, test, vi } from "vitest";
import { probeModelVision } from "../../src/models/vision.js";

/**
 * Stands in for a provider path that serialises a text-only body. The guard must refuse it
 * before the model's answer can be counted, whatever that answer says.
 */
vi.mock("@earendil-works/pi-ai/api/openai-completions", () => ({
  stream: (_model: unknown, _context: unknown, options: { fetch: typeof globalThis.fetch }) => (async function* () {
    await options.fetch("https://text-only-fixture.invalid/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "no images in this payload" }] }),
    });
    yield { type: "error", error: { errorMessage: "the probe accepted a payload without images" } };
  })(),
}));

const input = { provider: "openai-completions" as const, baseUrl: "https://text-only-fixture.invalid/v1", modelId: "fixture-vision", apiKey: "fixture-secret-not-real" };

test("a request that never carried the probe images cannot verify the model", async () => {
  const result = await probeModelVision(input, async () => {
    throw new Error("the wrapped fetch must never be reached without both images");
  }, new AbortController().signal);
  expect(result).toMatchObject({ state: "unknown", declaredImageInput: true, outboundImages: 0, answerMatched: false, verifiedOnAttempt: null });
  expect(result.attempts).toBe(1);
});
