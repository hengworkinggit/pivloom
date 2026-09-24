import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

// Next navigation is the framework boundary; the rendered UI, identity SDK,
// workspace adapter, validation and draft storage are the production modules.
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

let root: Root | undefined;
let disposeWorkspace: (() => void) | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  disposeWorkspace?.();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

it("creates only after a valid, committed idea is submitted from the actual project composer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
  const projectId = "6c9d405a-005a-4c6a-a177-b13dd8c5054c";
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = {
    id: ownerId, email: "owner@example.test", aud: "authenticated",
    app_metadata: {}, user_metadata: {}, created_at: "2026-09-22T00:00:00.000Z",
  };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  localStorage.setItem("pivloom.auth.v1", JSON.stringify({
    access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiresAt })}.fixture`,
    refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user,
  }));
  const submittedProjects: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://identity.example.test/auth/v1/user") return Response.json(user);
    if (url === "/api/v1/me") return Response.json({ user: { id: ownerId, email: user.email, name: "Owner" } });
    if (url === "/api/v1/model-profiles") return Response.json({ profiles: [{
      id: "438088cb-5fd0-4704-ad57-3b64ed47c55f", name: "已验证模型", provider: "openai-completions",
      baseUrl: "https://provider.example.test/v1", modelId: "fixture-model", configVersion: 3,
      keyMask: "••••0000", isDefault: true, capabilities: { streaming: "verified", tools: "verified", vision: "unknown" },
      lastTest: null, createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
    }] });
    if (url === "/api/v1/projects" && init?.method !== "POST") return Response.json({ projects: [], nextCursor: null });
    if (url === "/api/v1/projects" && init?.method === "POST") {
      submittedProjects.push(JSON.parse(String(init.body)));
      return Response.json({ project: {
        id: projectId, title: "做一个中文读书清单", currentRevisionId: null,
        createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
      } }, { status: 201 });
    }
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  const { getApiWorkspace } = await import("@/lib/workspace");
  const workspace = getApiWorkspace();
  disposeWorkspace = workspace.dispose;
  await workspace.initialize();
  const { ProjectsPage } = await import("./projects-page");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ProjectsPage />));

  const input = container.querySelector<HTMLTextAreaElement>("textarea");
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!input || !submit) throw new Error("The authenticated project composer did not render");
  expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("新项目需求");
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const enter = async (options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
    await act(async () => { input.dispatchEvent(event); });
    return event;
  };

  await type(" \n ");
  expect(submit.disabled).toBe(true);
  await enter();
  expect(submittedProjects).toEqual([]);

  await type("文".repeat(8001));
  expect(submit.disabled).toBe(true);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("8,000");
  await enter();
  expect(submittedProjects).toEqual([]);

  await type("做一个中文读书清单");
  expect(submit.disabled).toBe(false);
  await act(async () => { input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
  expect((await enter({ isComposing: true })).defaultPrevented).toBe(false);
  expect(submittedProjects).toEqual([]);
  await act(async () => { input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "清单" })); });
  expect((await enter({ keyCode: 229 })).defaultPrevented).toBe(false);
  expect(submittedProjects).toEqual([]);
  expect((await enter({ shiftKey: true })).defaultPrevented).toBe(false);
  expect(submittedProjects).toEqual([]);

  // The same DOM key handler must still submit after composition has finished.
  // This positive control prevents a missing/unwired event handler from passing.
  expect((await enter()).defaultPrevented).toBe(true);
  expect(submittedProjects).toEqual([{ title: "做一个中文读书清单" }]);
  expect(navigation.push).toHaveBeenCalledWith(`/projects/${projectId}?start=1`);
});
