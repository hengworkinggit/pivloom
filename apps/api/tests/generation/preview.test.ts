import { afterEach, expect, test } from "vitest";
import Fastify from "fastify";
import { createPreviewGateway } from "../../src/generation/preview.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });
const ownerId = "66182c8e-b9d2-4b81-9495-80b07fb3ac3e";
const revisionId = "ea471c34-dc56-4e5e-a8c5-ebd175d9279e";
const sandboxId = "116f131c-91de-45ba-81f8-3b45486ac26d";

test.each(["http://127.0.0.1:45311", "http://[::1]:45311"])("IP preview origin %s is rejected instead of silently inventing a DNS hostname", (publicOrigin) => {
  expect(() => createPreviewGateway({ publicOrigin, appOrigin: "http://localhost:45231", sandboxOrigin: "http://127.0.0.1:18080" }))
    .toThrow(/IP/);
});

test("non-localhost preview and workbench must use the same URL scheme for Lax cookies", () => {
  expect(() => createPreviewGateway({ publicOrigin: "https://preview.example.com", appOrigin: "http://app.example.com", sandboxOrigin: "http://127.0.0.1:18080" }))
    .toThrow(/scheme/);
});

test("HTTPS revision origins retain host-only Lax cookies and expired previews stay unavailable", async () => {
  const gateway = createPreviewGateway({ publicOrigin: "https://preview.example.com", appOrigin: "https://app.example.com", sandboxOrigin: "http://127.0.0.1:18080" });
  disposers.push(() => gateway.close());
  const registration = { ownerId, projectId: ownerId, revisionId, sandboxId, sourceHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), upstreamUrl: `http://127.0.0.1:18080/v1/sandboxes/${sandboxId}/proxy/4173`, headers: {} };
  const preview = gateway.register(registration);
  const url = new URL(preview.url!);
  expect(url.origin).toBe(`https://${revisionId}.preview.example.com`);
  const opened = await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: url.host } });
  expect(opened.statusCode).toBe(303);
  const cookie = String(opened.headers["set-cookie"]);
  expect(cookie).toContain("HttpOnly; SameSite=Lax;");
  expect(cookie).toContain("; Secure");
  expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
  const expired = gateway.register({ ...registration, expiresAt: new Date(Date.now() - 1).toISOString() });
  expect(expired).toMatchObject({ state: "expired", url: null });
  expect((await gateway.app.inject({ method: "GET", url: `/p/${revisionId}/`, headers: { host: url.host } })).statusCode).toBe(410);
});

test("each revision has its own origin and neither entry nor resources accept another revision's host or capability", async () => {
  const upstream = Fastify();
  const observed: string[] = [];
  upstream.get("/*", async (request) => { observed.push(request.url); return "preview fixture"; });
  const origin = await upstream.listen({ host: "127.0.0.1", port: 0 });
  disposers.push(() => upstream.close());
  const gateway = createPreviewGateway({ publicOrigin: "http://localhost:45311", appOrigin: "http://localhost:45231", sandboxOrigin: origin });
  disposers.push(() => gateway.close());
  const register = (id: string) => gateway.register({ ownerId, projectId: ownerId, revisionId: id, sandboxId,
    sourceHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    upstreamUrl: `${origin}/v1/sandboxes/${sandboxId}/proxy/4173`, headers: {} });
  const first = new URL(register(revisionId).url!);
  const second = new URL(register(ownerId).url!);
  expect(first.origin).toBe(`http://${revisionId}.localhost:45311`);
  expect(second.origin).toBe(`http://${ownerId}.localhost:45311`);
  expect(first.origin).not.toBe(second.origin);
  const cookies: string[] = [];
  for (const url of [first, second]) {
    const opened = await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: url.host } });
    expect(opened.statusCode).toBe(303);
    const header = String(opened.headers["set-cookie"]);
    expect(header).toContain("HttpOnly; SameSite=None;");
    expect(header).toContain("; Secure");
    expect(header).not.toMatch(/(?:^|;)\s*Domain=/i);
    cookies.push(header.split(";")[0]);
  }
  for (const [host, path, cookie] of [
    ["localhost:45311", first.pathname, cookies[0]],
    [second.host, first.pathname, cookies[0]],
    [first.host, second.pathname, cookies[1]],
    [second.host, `/p/${revisionId}/`, cookies[0]],
    [first.host, `/p/${ownerId}/`, cookies[1]],
    [first.host, `/p/${revisionId}/`, cookies[1]],
    [second.host, `/p/${ownerId}/`, cookies[0]],
  ]) {
    const rejected = await gateway.app.inject({ method: "GET", url: path, headers: { host, cookie } });
    expect(rejected.statusCode).toBe(403);
  }
  const swappedCapability = first.pathname.replace(revisionId, ownerId);
  expect((await gateway.app.inject({ method: "GET", url: swappedCapability, headers: { host: second.host } })).statusCode).toBe(404);
  expect(observed).toEqual([]);
  for (const [id, url, cookie] of [[revisionId, first, cookies[0]], [ownerId, second, cookies[1]]] as const) {
    const response = await gateway.app.inject({ method: "GET", url: `/p/${id}/`, headers: { host: url.host, cookie } });
    expect(response.statusCode).toBe(200);
  }
  expect(observed).toHaveLength(2);
  gateway.revoke(revisionId);
  expect((await gateway.app.inject({ method: "GET", url: first.pathname, headers: { host: first.host } })).statusCode).toBe(410);
  const restored = new URL(register(revisionId).url!);
  expect(restored.origin).toBe(first.origin);
  expect(restored.pathname).not.toBe(first.pathname);
  expect((await gateway.app.inject({ method: "GET", url: `/p/${revisionId}/`, headers: { host: first.host, cookie: cookies[0] } })).statusCode).toBe(403);
});

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
  expect(wrongRevision.statusCode).toBe(403);
  const untrustedHost = await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: "attacker.invalid" } });
  expect(untrustedHost.statusCode).toBe(403);
  gateway.revoke(revisionId);
  expect((await gateway.app.inject({ method: "GET", url: `/p/${revisionId}/`, headers: { host: url.host, cookie } })).statusCode).toBe(410);
  expect(observed).toHaveLength(1);
});

test("cleanup of an older sandbox leaves the restored preview for the same revision usable", async () => {
  const upstream = Fastify();
  const observed: string[] = [];
  upstream.get("/*", async (request) => { observed.push(request.url); return "restored preview"; });
  const origin = await upstream.listen({ host: "127.0.0.1", port: 0 });
  disposers.push(() => upstream.close());
  const gateway = createPreviewGateway({ publicOrigin: "http://localhost:45311", appOrigin: "http://localhost:45231", sandboxOrigin: origin });
  disposers.push(() => gateway.close());
  const register = (id: string) => gateway.register({ ownerId, projectId: ownerId, revisionId, sandboxId: id,
    sourceHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    upstreamUrl: `${origin}/v1/sandboxes/${id}/proxy/4173`, headers: {} });
  register(sandboxId);
  const restored = new URL(register(ownerId).url!);
  gateway.revoke(revisionId, sandboxId);
  const opened = await gateway.app.inject({ method: "GET", url: restored.pathname, headers: { host: restored.host } });
  expect(opened.statusCode).toBe(303);
  const cookie = String(opened.headers["set-cookie"]).split(";")[0];
  const request = { method: "GET" as const, url: `/p/${revisionId}/`, headers: { host: restored.host, cookie } };
  expect((await gateway.app.inject(request)).body).toBe("restored preview");
  expect(observed).toEqual([`/v1/sandboxes/${ownerId}/proxy/4173/p/${revisionId}/`]);
  gateway.revoke(revisionId, ownerId);
  expect((await gateway.app.inject(request)).statusCode).toBe(410);
});
