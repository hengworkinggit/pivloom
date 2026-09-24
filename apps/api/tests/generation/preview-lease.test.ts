import { expect, test } from "vitest";
import { createPreviewGateway } from "../../src/generation/preview.js";

const owner = "66182c8e-b9d2-4b81-9495-80b07fb3ac3e";
const revision = "ea471c34-dc56-4e5e-a8c5-ebd175d9279e";
const sandbox = "116f131c-91de-45ba-81f8-3b45486ac26d";

test("renewal updates only the current Preview binding and cannot revive a revoked sandbox", async () => {
  const gateway = createPreviewGateway({
    publicOrigin: "https://preview.example.com",
    appOrigin: "https://app.example.com",
    sandboxOrigin: "http://127.0.0.1:18080",
    isSessionActive: async () => true,
  });
  try {
    const oldExpiry = new Date(Date.now() + 60_000).toISOString();
    const newExpiry = new Date(Date.now() + 300_000).toISOString();
    gateway.register({
      ownerId: owner, projectId: owner, revisionId: revision, sandboxId: sandbox,
      sourceHash: "a".repeat(64), expiresAt: oldExpiry,
      upstreamUrl: `http://127.0.0.1:18080/v1/sandboxes/${sandbox}/proxy/4173`, headers: {},
    });
    expect(await gateway.renew("wrong-owner", revision, sandbox, newExpiry)).toBe(false);
    expect(await gateway.renew(owner, revision, "wrong-sandbox", newExpiry)).toBe(false);
    expect(gateway.get(owner, revision)?.expiresAt).toBe(oldExpiry);
    expect(await gateway.renew(owner, revision, sandbox, newExpiry)).toBe(true);
    expect(gateway.get(owner, revision)?.expiresAt).toBe(newExpiry);
    gateway.revoke(revision, sandbox);
    expect(await gateway.renew(owner, revision, sandbox, new Date(Date.now() + 600_000).toISOString())).toBe(false);
    expect(gateway.get(owner, revision)).toMatchObject({ state: "expired", expiresAt: newExpiry });
  } finally {
    await gateway.close();
  }
});
