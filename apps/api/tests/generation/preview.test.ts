import { afterEach, expect, test } from "vitest";
import Fastify from "fastify";
import { createPreviewGateway } from "../../src/generation/preview.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });
const ownerId = "66182c8e-b9d2-4b81-9495-80b07fb3ac3e";
const revisionId = "ea471c34-dc56-4e5e-a8c5-ebd175d9279e";
const sandboxId = "116f131c-91de-45ba-81f8-3b45486ac26d";

test("a preview capability opens only its registered revision without forwarding browser or control credentials", async () => {
  const upstream = Fastify();
  const observed: Array<Record<string, unknown>> = [];
  upstream.get("/*", async (request, reply) => {
    observed.push({ authorization: request.headers.authorization, cookie: request.headers.cookie, control: request.headers["x-control-key"], url: request.url });
    return reply.type("text/html").send("<h1>Isolated preview</h1>");
  });
  const origin = await upstream.listen({ host: "127.0.0.1", port: 0 });
  disposers.push(() => upstream.close());
  const gateway = createPreviewGateway({ publicOrigin: "http://localhost:45311", appOrigin: "http://localhost:45231", sandboxOrigin: origin });
  disposers.push(() => gateway.close());
  const preview = gateway.register({ ownerId, projectId: ownerId, revisionId, sandboxId, sourceHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), upstreamUrl: `${origin}/v1/sandboxes/${sandboxId}/proxy/4173`, headers: { "x-control-key": "fixture-management-secret" } });
  expect(gateway.get("another-owner", revisionId)).toBeNull();
  const url = new URL(preview.url!);
  const opened = await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: url.host } });
  expect(opened.statusCode).toBe(303);
  const cookie = String(opened.headers["set-cookie"]).split(";")[0];
  expect(String(opened.headers["set-cookie"])).toContain(`Path=/p/${revisionId}/`);
  expect(String(opened.headers["set-cookie"])).toContain("HttpOnly");
  const result = await gateway.app.inject({ method: "GET", url: `/p/${revisionId}/`, headers: { host: url.host, cookie, authorization: "Bearer fixture-user-token" } });
  expect(result.statusCode).toBe(200);
  expect(result.body).toContain("Isolated preview");
  expect(result.body).not.toContain("fixture-management-secret");
  expect(result.headers["content-security-policy"]).toContain("frame-ancestors http://localhost:45231");
  expect(observed).toEqual([{ authorization: undefined, cookie: undefined, control: "fixture-management-secret", url: `/v1/sandboxes/${sandboxId}/proxy/4173/p/${revisionId}/` }]);
  const wrongRevision = await gateway.app.inject({ method: "GET", url: `/p/${ownerId}/`, headers: { host: url.host, cookie } });
  expect(wrongRevision.statusCode).toBe(404);
  const untrustedHost = await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: "attacker.invalid" } });
  expect(untrustedHost.statusCode).toBe(403);
  gateway.revoke(revisionId);
  expect((await gateway.app.inject({ method: "GET", url: `/p/${revisionId}/`, headers: { host: url.host, cookie } })).statusCode).toBe(410);
  expect(observed).toHaveLength(1);
});
