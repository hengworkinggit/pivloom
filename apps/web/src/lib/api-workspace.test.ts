import { afterEach, describe, expect, it } from "vitest";
import { createApiWorkspace, type IdentityPort, type TokenSession } from "./api-workspace";
import { readDraft, saveDraft } from "./drafts";

afterEach(() => { sessionStorage.clear(); });

const owner = "1e5dce44-654d-4352-bb4b-7680138c1135";
const profile = { id: owner, name: "测试用户 A", email: "owner-a@example.test" };
const project = {
  id: "d48d8527-9c46-465f-8a75-8be51d687157", title: "活动管理",
  createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
  currentRevisionId: null,
};

function identityFixture() {
  let session: TokenSession | null = { accessToken: "fixture-token-a", userId: owner };
  const listeners = new Set<(session: TokenSession | null) => void>();
  const identity: IdentityPort = {
    getSession: async () => session,
    getUser: async () => ({ id: owner }),
    signIn: async () => session!,
    refreshSession: async () => session,
    signOut: async () => { session = null; listeners.forEach((listener) => listener(null)); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return identity;
}

describe("real workspace HTTP/auth boundary (fixtures, not cloud E2E)", () => {
  it("discards an in-flight private response as soon as the user signs out", async () => {
    let release: (response: Response) => void = () => { throw new Error("Request has not started"); };
    let began: () => void = () => {};
    const requested = new Promise<void>((resolve) => { began = resolve; });
    const transport: typeof fetch = async (input) => {
      if (String(input).endsWith("/me")) return Response.json({ user: profile });
      began();
      return new Promise<Response>((resolve) => { release = resolve; });
    };
    const workspace = createApiWorkspace(identityFixture(), transport);
    await workspace.initialize();
    expect(workspace.getSnapshot().user?.name).toBe("测试用户 A");
    const result = workspace.listProjects();
    const rejected = expect(result).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await requested;
    await workspace.logout();
    expect(workspace.getSnapshot().status).toBe("anonymous");
    expect(workspace.getSnapshot().user).toBeNull();
    release(Response.json({ projects: [project], nextCursor: null }));
    await rejected;
    workspace.dispose();
  });

  it("refreshes once after a 401, then clears the workspace if authentication still fails", async () => {
    let refreshes = 0;
    let projectRequests = 0;
    const identity = identityFixture();
    const workspace = createApiWorkspace({
      ...identity,
      refreshSession: async () => { refreshes += 1; return { accessToken: "fixture-token-refreshed", userId: owner }; },
    }, async (input) => {
      if (String(input).endsWith("/me")) return Response.json({ user: profile });
      projectRequests += 1;
      return Response.json({ error: { code: "UNAUTHENTICATED", message: "Login required", retryable: false, requestId: "fixture" } }, { status: 401 });
    });
    await workspace.initialize();
    await expect(workspace.listProjects()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(refreshes).toBe(1);
    expect(projectRequests).toBe(2);
    expect(workspace.getSnapshot().user).toBeNull();
    expect(workspace.getSnapshot().status).toBe("anonymous");
    await expect(workspace.listProjects()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(projectRequests).toBe(2);
    workspace.dispose();
  });

  it("never retries a private request with a different account returned by session refresh", async () => {
    let projectRequests = 0;
    const workspace = createApiWorkspace({
      ...identityFixture(),
      refreshSession: async () => ({ accessToken: "fixture-token-b", userId: "878ea1d0-a9f6-4766-8789-315d573bd9eb" }),
    }, async (input) => {
      if (String(input).endsWith("/me")) return Response.json({ user: profile });
      projectRequests += 1;
      return Response.json({}, { status: 401 });
    });
    await workspace.initialize();
    await expect(workspace.getProject(project.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(projectRequests).toBe(1);
    expect(workspace.getSnapshot().user).toBeNull();
    workspace.dispose();
  });

  it("finishes the previous sign-out before accepting a new login", async () => {
    const current: TokenSession = { accessToken: "fixture-token-a", userId: owner };
    let finishSignOut: () => void = () => {};
    let signIns = 0;
    const identity = identityFixture();
    const workspace = createApiWorkspace({
      ...identity,
      signOut: () => new Promise<void>((resolve) => { finishSignOut = resolve; }),
      signIn: async () => { signIns += 1; return current; },
    }, async () => Response.json({ user: profile }));
    await workspace.initialize();
    const oldSignOut = workspace.logout();
    const newLogin = workspace.login(profile.email, "fixture-password");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signIns).toBe(0);
    finishSignOut();
    await oldSignOut;
    await newLogin;
    expect(workspace.getSnapshot().status).toBe("authenticated");
    workspace.dispose();
  });

  it("can delete a saved profile through an API that rejects empty JSON bodies", async () => {
    const workspace = createApiWorkspace(identityFixture(), async (input, init) => {
      if (String(input).endsWith("/me")) return Response.json({ user: profile });
      if (!init?.body && new Headers(init?.headers).get("content-type") === "application/json") {
        return Response.json({ error: { code: "EMPTY_JSON_BODY", message: "An empty body cannot be JSON", retryable: false, requestId: "fixture" } }, { status: 400 });
      }
      return new Response(null, { status: 204 });
    });
    await workspace.initialize();
    await expect(workspace.request(`/model-profiles/${project.id}`, { method: "DELETE" })).resolves.toBeNull();
    workspace.dispose();
  });

  it("clears only the active owner's drafts when the user explicitly signs out", async () => {
    saveDraft(owner, project.id, "未发送的活动报名需求");
    saveDraft(owner, "new", "另一个未发送想法");
    saveDraft("other-owner", project.id, "属于另一个账号的草稿");
    const workspace = createApiWorkspace(identityFixture(), async () => Response.json({ user: profile }));
    await workspace.initialize();
    await workspace.logout();
    expect(readDraft(owner, project.id)).toBe("");
    expect(readDraft(owner, "new")).toBe("");
    expect(readDraft("other-owner", project.id)).toBe("属于另一个账号的草稿");
    workspace.dispose();
  });

  it("keeps the owner's unsent draft when an expired session requires another login", async () => {
    saveDraft(owner, project.id, "登录恢复后继续修改");
    const workspace = createApiWorkspace(identityFixture(), async (input) => String(input).endsWith("/me")
      ? Response.json({ user: profile }) : Response.json({}, { status: 401 }));
    await workspace.initialize();
    await expect(workspace.listProjects()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(workspace.getSnapshot().status).toBe("anonymous");
    expect(readDraft(owner, project.id)).toBe("登录恢复后继续修改");
    expect(readDraft("other-owner", project.id)).toBe("");
    workspace.dispose();
  });
});
