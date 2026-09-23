import { afterEach, expect, test } from "vitest";
import Fastify from "fastify";
import { createPreviewGateway } from "../../src/generation/preview.js";

const owner = "66182c8e-b9d2-4b81-9495-80b07fb3ac3e";
const other = "dc727d07-8018-4e6f-898a-0e24b5d5fd2a";
const revision = "ea471c34-dc56-4e5e-a8c5-ebd175d9279e";
const sandbox = "116f131c-91de-45ba-81f8-3b45486ac26d";
const a1 = "d20ee9e1-c602-4c2f-b052-899c934c0616";
const a2 = "04a6d5b6-d370-48cf-bf92-78289c43bc21";
const b = "4045713c-d888-4acd-961c-af9dd8a3b680";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });

test("private Preview is bound to owner, revision and a live Supabase session without URL credentials", async () => {
  const upstream = Fastify();
  const observed: string[] = [];
  upstream.get("/*", async (request) => { observed.push(request.url); return `resource ${request.url}`; });
  const sandboxOrigin = await upstream.listen({ host: "127.0.0.1", port: 0 });
  disposers.push(() => upstream.close());
  const live = new Set([a1, a2, b]);
  const gateway = createPreviewGateway({ publicOrigin: "https://preview.example.com", appOrigin: "https://app.example.com",
    sandboxOrigin, isSessionActive: async (ownerId, sessionId) => (ownerId === owner && live.has(sessionId)) || (ownerId === other && sessionId === b) });
  disposers.push(() => gateway.close());
  const preview = gateway.register({ ownerId: owner, projectId: owner, revisionId: revision, sandboxId: sandbox,
    sourceHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    upstreamUrl: `${sandboxOrigin}/v1/sandboxes/${sandbox}/proxy/4173`, headers: { "x-control-key": "fixture-secret" } });
  const url = new URL(preview.url!);
  expect(url.pathname).toBe(`/p/${revision}/`);
  expect(url.href).not.toMatch(/enter|capability|token|grant/);
  expect((await gateway.app.inject({ method: "GET", url: url.pathname, headers: { host: url.host } })).statusCode).toBe(403);
  expect(await gateway.issueGrant(other, revision, b)).toBeNull();
  const first = await gateway.issueGrant(owner, revision, a1);
  const second = await gateway.issueGrant(owner, revision, a2);
  if (!first || !second) throw new Error("live owner sessions must receive Preview grants");
  expect(first).not.toBe(second);
  const exchange = async (grant: string) => gateway.app.inject({ method: "POST", url: `/p/${revision}/session`,
    headers: { host: url.host, origin: "https://app.example.com", authorization: `Preview ${grant}` } });
  expect((await exchange("invalid")).statusCode).toBe(403);
  const firstExchange = await exchange(first);
  const secondExchange = await exchange(second);
  expect(firstExchange.statusCode).toBe(204);
  expect(firstExchange.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  const cookie1 = String(firstExchange.headers["set-cookie"]).split(";")[0];
  const cookie2 = String(secondExchange.headers["set-cookie"]).split(";")[0];
  expect(String(firstExchange.headers["set-cookie"])).toContain(`Path=/p/${revision}/; HttpOnly; SameSite=Lax;`);
  expect(String(firstExchange.headers["set-cookie"])).toContain("; Secure");
  expect(String(firstExchange.headers["set-cookie"])).not.toMatch(/(?:^|;)\s*Domain=/i);
  for (const path of ["", "assets/app.js", "marker.json"]) {
    const request = (cookie: string) => gateway.app.inject({ method: "GET", url: `/p/${revision}/${path}`, headers: { host: url.host, cookie } });
    expect((await request(cookie1)).statusCode).toBe(200);
    expect((await request(cookie2)).statusCode).toBe(200);
  }
  expect(observed).toHaveLength(6);
  live.delete(a1); // Supabase local signOut deletes only this auth.sessions row.
  for (const path of ["", "assets/app.js", "marker.json"]) {
    expect((await gateway.app.inject({ method: "GET", url: `/p/${revision}/${path}`, headers: { host: url.host, cookie: cookie1 } })).statusCode).toBe(403);
    expect((await gateway.app.inject({ method: "GET", url: `/p/${revision}/${path}`, headers: { host: url.host, cookie: cookie2 } })).statusCode).toBe(200);
  }
  expect((await exchange(first)).statusCode).toBe(403);
  expect((await gateway.app.inject({ method: "POST", url: `/p/${revision}/session`, headers: {
    host: url.host, origin: "https://evil.example.com", authorization: `Preview ${second}`,
  } })).statusCode).toBe(403);
  expect(observed).toHaveLength(9);
  const cleared = await gateway.app.inject({ method: "POST", url: `/p/${revision}/session/clear`,
    headers: { host: url.host, origin: "https://app.example.com", cookie: cookie1 } });
  expect(cleared.statusCode).toBe(204);
  expect(String(cleared.headers["set-cookie"])).toContain(`Path=/p/${revision}/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
  expect(String(cleared.headers["set-cookie"])).not.toMatch(/(?:^|;)\s*Domain=/i);
});
