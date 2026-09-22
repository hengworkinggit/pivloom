import { expect, test } from "vitest";
import { createModelFetch, validateModelEndpoint } from "../../src/models/transport.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { randomBytes } from "node:crypto";

test.each([
  "http://api.openai.com/v1", "https://user:password@api.openai.com/v1",
  "https://127.0.0.1/v1", "https://169.254.169.254/latest", "https://10.0.0.1/v1",
  "https://[::1]/v1", "https://[::ffff:127.0.0.1]/v1", "https://localhost/v1",
])("a BYOK endpoint cannot target non-public or credential-bearing URLs: %s", async (url) => {
  await expect(validateModelEndpoint(url)).rejects.toMatchObject({ code: "MODEL_ENDPOINT_NOT_ALLOWED" });
});

test("the model transport refuses a provider request escaping the configured origin", async () => {
  const transport = createModelFetch("https://api.openai.com/v1");
  await expect(transport("https://example.com/stolen-key", { method: "POST" })).rejects.toMatchObject({ code: "MODEL_ENDPOINT_NOT_ALLOWED" });
});

test("the model transport permits only the SDK's beta=true message query without following another target", async () => {
  const transport = createModelFetch("https://1.1.1.1/v1");
  await expect(transport("https://1.1.1.1/v1/messages?beta=true", {
    method: "POST", signal: AbortSignal.abort(),
  })).rejects.toMatchObject({ name: "AbortError" });
  for (const url of [
    "https://1.1.1.1/v1/messages?beta=false", "https://1.1.1.1/v1/messages?beta=true&redirect=http://127.0.0.1",
    "https://1.1.1.1/v1/chat/completions?beta=true", "https://1.1.1.1/v1/messages?api_key=secret",
  ]) {
    await expect(transport(url, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "MODEL_ENDPOINT_NOT_ALLOWED" });
  }
});

test("an encrypted credential cannot be moved to another owner or configuration version", () => {
  const vault = createCredentialVault(randomBytes(32).toString("base64"));
  const scope = { ownerId: "owner-a", profileId: "profile-a", version: 1 };
  const secret = "fixture-api-key-not-real";
  const encrypted = vault.seal(secret, scope);
  expect(encrypted.ciphertext.toString("utf8")).not.toContain(secret);
  expect(vault.open(encrypted, scope)).toBe(secret);
  expect(() => vault.open(encrypted, { ...scope, ownerId: "owner-b" })).toThrow();
  expect(() => vault.open(encrypted, { ...scope, version: 2 })).toThrow();
});
