import { expect, test } from "vitest";
import { RemoteBrowser } from "../../src/runtime/browser.js";
import { OpenSandboxWorkspace } from "../../src/runtime/workspace.js";

function browser() {
  return new RemoteBrowser(
    new OpenSandboxWorkspace({
      baseUrl: "http://localhost:18080",
      apiKey: "fixture",
      image: "fixture",
    }),
    { sandboxId: "uncreated", expiresAt: "2030-01-01T00:00:00Z" },
  );
}

test("browser opening rejects an external origin before any remote command", async () => {
  for (const path of [
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/\0",
  ]) {
    await expect(browser().open(path)).rejects.toMatchObject({
      code: "BROWSER_ORIGIN_REJECTED",
    });
  }
});

test("refs from another observation or session cannot be acted on", async () => {
  await expect(
    browser().act({
      type: "click",
      ref: "e1",
      observationId: "another-session-observation",
    }),
  ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
});
