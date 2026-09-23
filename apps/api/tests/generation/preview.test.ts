import { afterEach, expect, test } from "vitest";
import Fastify from "fastify";
import { createPreviewGateway, type PreviewGateway } from "../../src/generation/preview.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });
const owner = "66182c8e-b9d2-4b81-9495-80b07fb3ac3e";
const revision = "ea471c34-dc56-4e5e-a8c5-ebd175d9279e";
const secondRevision = "dc727d07-8018-4e6f-898a-0e24b5d5fd2a";
const sandbox = "116f131c-91de-45ba-81f8-3b45486ac26d";
const restoredSandbox = "7c94fd77-4d6b-41f2-9981-c3683c3a6034";
const session = "d20ee9e1-c602-4c2f-b052-899c934c0616";
const active = async (ownerId: string, sessionId: string) => ownerId === owner && sessionId === session;
const gatewayFor = (sandboxOrigin: string, local = true) => createPreviewGateway({
  publicOrigin: local ? "http://localhost:45311" : "https://preview.example.com",
  appOrigin: local ? "http://localhost:45231" : "https://app.example.com",
  sandboxOrigin, isSessionActive: active,
});
const registration = (origin: string, revisionId = revision, sandboxId = sandbox) => ({
  ownerId: owner, projectId: owner, revisionId, sandboxId, sourceHash: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  upstreamUrl: origin + "/v1/sandboxes/" + sandboxId + "/proxy/4173",
  headers: { "x-control-key": "fixture-management-secret" },
});
async function open(gateway: PreviewGateway, url: URL, revisionId: string) {
  const grant = await gateway.issueGrant(owner, revisionId, session);
  expect(grant).toMatch(/^[a-f0-9]{64}$/);
  const response = await gateway.app.inject({ method: "POST", url: "/p/" + revisionId + "/session",
    headers: { host: url.host, origin: url.protocol === "https:" ? "https://app.example.com" : "http://localhost:45231",
      authorization: "Preview " + grant } });
  expect(response.statusCode).toBe(204);
  return String(response.headers["set-cookie"]).split(";")[0];
}

test.each(["http://127.0.0.1:45311", "http://[::1]:45311"])("IP preview origin %s is rejected", (publicOrigin) => {
  expect(() => createPreviewGateway({ publicOrigin, appOrigin: "http://localhost:45231",
    sandboxOrigin: "http://127.0.0.1:18080", isSessionActive: active })).toThrow(/IP/);
});

test("production Preview and workbench use the same URL scheme for Lax cookies", () => {
  expect(() => createPreviewGateway({ publicOrigin: "https://preview.example.com", appOrigin: "http://app.example.com",
    sandboxOrigin: "http://127.0.0.1:18080", isSessionActive: active })).toThrow(/scheme/);
});

test("expired Preview has no authorization URL or cookie bootstrap", async () => {
  const gateway = gatewayFor("http://127.0.0.1:18080", false);
  disposers.push(() => gateway.close());
  const preview = gateway.register({ ...registration("http://127.0.0.1:18080"), expiresAt: new Date(Date.now() - 1).toISOString() });
  expect(preview).toMatchObject({ state: "expired", url: null });
  expect(await gateway.issueGrant(owner, revision, session)).toBeNull();
  const host = revision + ".preview.example.com";
  expect((await gateway.app.inject({ method: "GET", url: "/p/" + revision + "/", headers: { host } })).statusCode).toBe(410);
});

test("revision host and resource cookie are isolated; browser secrets never reach sandbox", async () => {
  const upstream = Fastify();
  const observed: Array<Record<string, unknown>> = [];
  upstream.get("/*", async (request, reply) => {
    observed.push({ authorization: request.headers.authorization, cookie: request.headers.cookie,
      control: request.headers["x-control-key"], url: request.url });
    return reply.type("text/html").send("<h1>Isolated preview</h1>");
  });
  const origin = await upstream.listen({ host: "127.0.0.1", port: 0 });
  disposers.push(() => upstream.close());
  const gateway = gatewayFor(origin);
  disposers.push(() => gateway.close());
  const first = new URL(gateway.register(registration(origin)).url!);
  const second = new URL(gateway.register(registration(origin, secondRevision)).url!);
  expect(first.origin).not.toBe(second.origin);
  const cookie1 = await open(gateway, first, revision);
  const cookie2 = await open(gateway, second, secondRevision);
  expect((await gateway.app.inject({ method: "GET", url: first.pathname, headers: { host: first.host } })).statusCode).toBe(403);
  for (const [host, path, cookie] of [
    [second.host, first.pathname, cookie1], [first.host, second.pathname, cookie2],
    [first.host, first.pathname, cookie2], [second.host, second.pathname, cookie1],
  ]) expect((await gateway.app.inject({ method: "GET", url: path, headers: { host, cookie } })).statusCode).toBe(403);
  expect(observed).toEqual([]);
  const response = await gateway.app.inject({ method: "GET", url: first.pathname,
    headers: { host: first.host, cookie: cookie1, authorization: "Bearer browser-user-token" } });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("Isolated preview");
  expect(response.headers["content-security-policy"]).toContain("frame-ancestors http://localhost:45231");
  expect(observed).toEqual([{ authorization: undefined, cookie: undefined, control: "fixture-management-secret",
    url: "/v1/sandboxes/" + sandbox + "/proxy/4173/p/" + revision + "/" }]);
  expect((await gateway.app.inject({ method: "GET", url: first.pathname, headers: { host: "attacker.invalid", cookie: cookie1 } })).statusCode).toBe(403);
  gateway.revoke(revision);
  expect((await gateway.app.inject({ method: "GET", url: first.pathname, headers: { host: first.host, cookie: cookie1 } })).statusCode).toBe(410);
  expect((await gateway.app.inject({ method: "GET", url: second.pathname, headers: { host: second.host, cookie: cookie2 } })).statusCode).toBe(200);
});

test("delayed old sandbox cleanup does not revoke a restored revision", async () => {
  const upstream = Fastify();
  upstream.get("/*", async () => "restored preview");
  const origin = await upstream.listen({ host: "127.0.0.1", port: 0 });
  disposers.push(() => upstream.close());
  const gateway = gatewayFor(origin);
  disposers.push(() => gateway.close());
  const url = new URL(gateway.register(registration(origin)).url!);
  const oldCookie = await open(gateway, url, revision);
  gateway.register(registration(origin, revision, restoredSandbox));
  gateway.revoke(revision, sandbox);
  expect((await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: url.host, cookie: oldCookie } })).statusCode).toBe(403);
  const newCookie = await open(gateway, url, revision);
  expect((await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: url.host, cookie: newCookie } })).body).toBe("restored preview");
  gateway.revoke(revision, restoredSandbox);
  expect((await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: url.host, cookie: newCookie } })).statusCode).toBe(410);
});
