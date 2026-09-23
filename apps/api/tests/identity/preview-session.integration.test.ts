import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createPreviewGateway } from "../../src/generation/preview.js";

// Opt-in: real Supabase Auth sessions + PostgreSQL function and a fixture
// resource server. No model, production project, or sandbox is modified.
describe.skipIf(process.env.PIVLOOM_PREVIEW_SESSION_INTEGRATION !== "1")("real Preview session revocation", () => {
  test("local signOut revokes A1's old cookie/grant while independent A2 remains active", async () => {
    const identity = JSON.parse(await readFile(process.env.PIVLOOM_IDENTITY_MANIFEST!, "utf8")) as {
      users: Array<{ label: string; id: string; email: string; password: string }>;
    };
    const owner = identity.users.find((user) => user.label === "A");
    if (!owner) throw new Error("isolated A test identity missing");
    const authUrl = process.env.SUPABASE_URL!;
    const publishable = process.env.SUPABASE_PUBLISHABLE_KEY!;
    const makeClient = () => createClient(authUrl, publishable, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const a1 = makeClient(), a2 = makeClient();
    const dbUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
    dbUrl.pathname = "/postgres"; // same isolated test cluster's Supabase Auth database
    const database = new PivloomDatabase(dbUrl.toString());
    const upstream = Fastify();
    upstream.get("/*", async (request) => "fixture " + request.url);
    const sandboxOrigin = await upstream.listen({ host: "127.0.0.1", port: 0 });
    const active = (ownerId: string, sessionId: string) => database.system(async (client) => {
      const result = await client.query<{ active: boolean }>("SELECT nano.preview_session_active($1::uuid,$2::uuid) AS active", [ownerId, sessionId]);
      return result.rows[0]?.active === true;
    });
    const gateway = createPreviewGateway({ publicOrigin: "http://localhost:45316", appOrigin: "http://localhost:45315",
      sandboxOrigin, isSessionActive: active });
    try {
      const login = async (client: typeof a1) => {
        const { data, error } = await client.auth.signInWithPassword({ email: owner.email, password: owner.password });
        if (error || !data.session || data.user?.id !== owner.id) throw new Error("isolated A login failed");
        const claims = JSON.parse(Buffer.from(data.session.access_token.split(".")[1], "base64url").toString()) as { session_id: string };
        return { sessionId: claims.session_id };
      };
      const first = await login(a1);
      const second = await login(a2);
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(await active(owner.id, first.sessionId)).toBe(true);
      expect(await active(owner.id, second.sessionId)).toBe(true);
      expect(await active("dc727d07-8018-4e6f-898a-0e24b5d5fd2a", first.sessionId)).toBe(false);
      const revision = "ea471c34-dc56-4e5e-a8c5-ebd175d9279e";
      const sandbox = "116f131c-91de-45ba-81f8-3b45486ac26d";
      const preview = gateway.register({ ownerId: owner.id, projectId: owner.id, revisionId: revision, sandboxId: sandbox,
        sourceHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        upstreamUrl: sandboxOrigin + "/v1/sandboxes/" + sandbox + "/proxy/4173", headers: {} });
      const target = new URL(preview.url!);
      const exchange = async (sessionId: string) => {
        const grant = await gateway.issueGrant(owner.id, revision, sessionId);
        if (!grant) throw new Error("live session grant missing");
        const response = await gateway.app.inject({ method: "POST", url: "/p/" + revision + "/session",
          headers: { host: target.host, origin: "http://localhost:45315", authorization: "Preview " + grant } });
        expect(response.statusCode).toBe(204);
        return { grant, cookie: String(response.headers["set-cookie"]).split(";")[0] };
      };
      const firstAccess = await exchange(first.sessionId);
      const secondAccess = await exchange(second.sessionId);
      const resource = (cookie: string, path = "") => gateway.app.inject({ method: "GET", url: "/p/" + revision + "/" + path,
        headers: { host: target.host, cookie } });
      expect((await resource(firstAccess.cookie)).statusCode).toBe(200);
      expect((await resource(secondAccess.cookie, "assets/app.js")).statusCode).toBe(200);
      const { error: signOutError } = await a1.auth.signOut({ scope: "local" });
      expect(signOutError).toBeNull();
      expect(await active(owner.id, first.sessionId)).toBe(false);
      expect(await active(owner.id, second.sessionId)).toBe(true);
      for (const path of ["", "assets/app.js", "marker.json"])
        expect((await resource(firstAccess.cookie, path)).statusCode).toBe(403);
      expect((await gateway.app.inject({ method: "POST", url: "/p/" + revision + "/session",
        headers: { host: target.host, origin: "http://localhost:45315", authorization: "Preview " + firstAccess.grant } })).statusCode).toBe(403);
      expect((await resource(secondAccess.cookie, "marker.json")).statusCode).toBe(200);
    } finally {
      await a1.auth.signOut({ scope: "local" }).catch(() => undefined);
      await a2.auth.signOut({ scope: "local" }).catch(() => undefined);
      await gateway.close();
      await upstream.close();
      await database.close();
    }
  }, 60_000);
});
