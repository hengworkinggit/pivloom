import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); vi.resetModules(); });

it("keeps a stored login when the external identity service is temporarily rate limited", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const id = "1e5dce44-654d-4352-bb4b-7680138c1135";
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const session = {
    access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, exp: expiresAt })}.fixture`,
    refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt,
    user: { id, email: "owner@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-22T00:00:00.000Z" },
  };
  localStorage.setItem("pivloom.auth.v1", JSON.stringify(session));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/auth/v1/user")) return Response.json({ message: "Try again later", code: "over_request_rate_limit" }, { status: 429 });
    return new Response(null, { status: 204 });
  });
  const { getApiWorkspace } = await import("./workspace");
  const workspace = getApiWorkspace();
  await workspace.initialize();
  expect(workspace.getSnapshot().status).toBe("error");
  expect(workspace.getSnapshot().user).toBeNull();
  expect(localStorage.getItem("pivloom.auth.v1")).not.toBeNull();
  workspace.dispose();
});

it("reports an identity rate limit as temporary unavailability instead of incorrect credentials", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  let tokenRequests = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/auth/v1/token")) {
      tokenRequests += 1;
      return Response.json({ message: "Try again later", code: "over_request_rate_limit" }, { status: 429 });
    }
    throw new Error("Unexpected external identity endpoint");
  });
  const { getApiWorkspace } = await import("./workspace");
  const workspace = getApiWorkspace();
  await workspace.initialize();
  await expect(workspace.login("owner@example.test", "fixture-password")).rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });
  expect(tokenRequests).toBe(1);
  expect(workspace.getSnapshot().user).toBeNull();
  workspace.dispose();
});
