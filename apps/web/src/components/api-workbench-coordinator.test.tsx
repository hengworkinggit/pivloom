import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { saveDraft } from "@/lib/drafts";
import type { Plan, ProjectDetailResponse, RoleRun, Run } from "@pivloom/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
let root: Root | undefined;
let disposeWorkspace: (() => void) | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  disposeWorkspace?.(); document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
});

const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
const profileId = "438088cb-5fd0-4704-ad57-3b64ed47c55f";
const runId = "74b24d87-1342-4d43-8c4e-f82e766a0633";
const childRunId = "9db423b2-dfcb-4429-852a-a0df45beb9e3";
const question = "报名提交后，是立即确认还是等待主办方确认？";
const now = "2026-09-22T00:00:00.000Z";
const plan: Plan = {
  schemaVersion: 1, goal: "创建可筛选的活动报名演示", changeSummary: "提供活动选择、报名和筛选。",
  assumptions: ["使用当前浏览器保存演示数据。"], outOfScope: ["本次仅实现演示交互，不接入真实支付。"],
  behaviors: [
    { id: "B01", title: "提交活动报名", precondition: "打开报名页", action: "输入中文姓名并提交", expected: "报名列表出现这个姓名", required: true },
    { id: "B02", title: "筛选报名状态", precondition: "已有两种状态的报名", action: "选择已确认状态", expected: "列表只显示已确认的报名", required: true },
  ],
};

async function openWorkbench(options: { needsInput?: boolean; proxyFailureOnce?: boolean } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: ownerId, email: "owner@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: now };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  localStorage.setItem("pivloom.auth.v1", JSON.stringify({ access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiresAt })}.fixture`, refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user }));
  saveDraft(ownerId, projectId, "下一条中文需求");
  const run: Run = { id: runId, projectId, state: "building", phase: "implement", attempt: 0, requestText: "创建活动报名演示", modelProfileId: profileId, modelConfigVersion: 3, modelId: null, baseRevisionId: null, resultRevisionId: null, createdAt: now, deadlineAt: "2026-09-22T00:10:00.000Z", finishedAt: null, cleanupState: "clear", error: null, summary: null, plan, clarification: null, parentRunId: null };
  const coordinatorId = "8f867b3d-0da2-430d-b3e9-cbf72d51e615";
  const roles: RoleRun[] = [
    { id: coordinatorId, runId, role: "coordinator", attempt: 0, sessionId: "9e9ec313-c626-45b3-836e-d3dfb1c21459", state: "succeeded", predecessorId: null, startedAt: now, finishedAt: now },
    { id: "5d9cf5ab-37f5-4b63-84c6-064111de78e6", runId, role: "builder", attempt: 0, sessionId: "f40df64a-4c3b-4b83-988c-9e918fba409d", state: "running", predecessorId: coordinatorId, startedAt: now, finishedAt: null },
  ];
  const project: ProjectDetailResponse = { project: { id: projectId, title: "活动报名", createdAt: now, updatedAt: now, currentRevisionId: null }, messages: [{ id: "ade806dc-49c3-4b16-950d-6f69c46bb4d8", projectId, runId, kind: "user", content: run.requestText, createdAt: now }], currentRevision: null, activeRun: run, latestRun: run, latestCandidate: null, latestCheck: null, preview: null };
  if (options.needsInput) {
    Object.assign(run, { state: "needs_input", phase: "plan", plan: null, clarification: { question }, summary: question, finishedAt: now, cleanupState: "confirmed" });
    project.activeRun = null;
    roles.splice(1);
    project.messages.push({ id: "3d604a82-afc9-4d2d-8d68-10c472cd891a", projectId, runId, kind: "question", content: question, createdAt: now });
  }
  let childRun: Run | undefined;
  let childRoles: RoleRun[] = [];
  let holdProject = false;
  const pendingProjects: (() => void)[] = [];
  const requests: { url: string; method: string; body?: unknown; key: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("Idempotency-Key") });
    if (url === "https://identity.example.test/auth/v1/user") return Response.json(user);
    if (url === "/api/v1/me") return Response.json({ user: { id: ownerId, name: "Owner", email: user.email } });
    if (url === "/api/v1/model-profiles") return Response.json({ profiles: [{ id: profileId, name: "已验证模型", provider: "openai-completions", baseUrl: "https://provider.example.test/v1", modelId: "fixture-model", configVersion: 3, keyMask: "••••0000", isDefault: true, capabilities: { streaming: "verified", tools: "verified", vision: "unknown" }, lastTest: null, createdAt: now, updatedAt: now }] });
    if (url === `/api/v1/model-profiles/${profileId}/models`) return Response.json({ source: "none", models: [] });
    if (url === `/api/v1/projects/${projectId}`) {
      const snapshot = Response.json(project);
      if (holdProject) {
        holdProject = false;
        return new Promise<Response>((resolve) => pendingProjects.push(() => resolve(snapshot)));
      }
      return snapshot;
    }
    if (url === `/api/v1/projects/${projectId}/runs`) {
      const body = JSON.parse(String(init?.body));
      if (!childRun) {
        childRun = { ...run, id: childRunId, state: "building", phase: "implement", requestText: body.text, plan, clarification: null, parentRunId: body.parentRunId, finishedAt: null, cleanupState: "clear", summary: null };
        const childCoordinatorId = "44368bde-74fd-44df-a66a-02b0928c7679";
        childRoles = [
          { ...roles[0], id: childCoordinatorId, runId: childRunId, sessionId: "13ad542c-b213-425e-8b1c-b79d0c50e8c0" },
          { ...roles[0], id: "dc6a10ce-0117-4485-9ecb-c758de7f2e70", runId: childRunId, role: "builder", state: "running", predecessorId: childCoordinatorId, sessionId: "ba00b9e8-0620-4cce-b248-1e36bd950aaa", finishedAt: null },
        ];
        project.activeRun = childRun; project.latestRun = childRun;
        project.messages.push({ id: "7ae6cddf-c00d-4b94-9556-c3c2b4a76608", projectId, runId: childRunId, kind: "user", content: body.text, createdAt: now });
        if (options.proxyFailureOnce) return new Response("Bad Gateway", { status: 502 });
      }
      return Response.json({ runId: childRunId, state: "building", eventsUrl: `/api/v1/runs/${childRunId}/events`, replayed: requests.filter((request) => request.method === "POST").length > 1 }, { status: 202 });
    }
    if (url === `/api/v1/runs/${runId}`) return Response.json({ run, roles, revision: null, events: [], preview: null });
    if (childRun && url === `/api/v1/runs/${childRunId}`) return Response.json({ run: childRun, roles: childRoles, revision: null, events: [], preview: null });
    if (url.includes("/events?")) return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  const { getApiWorkspace } = await import("@/lib/workspace");
  const workspace = getApiWorkspace(); disposeWorkspace = workspace.dispose; await workspace.initialize();
  const { ApiWorkbench } = await import("./api-workbench");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async () => { await act(async () => root?.render(<ApiWorkbench projectId={projectId} />)); };
  await render();
  return { container, run, roles, project, requests, render,
    holdNextProject() { holdProject = true; },
    releaseProject() {
      const release = pendingProjects.shift();
      if (!release) throw new Error("No held project response");
      release();
    },
  };
}

it("shows persisted coordinator goals, observable behaviors and actual roles without requiring plan approval", async () => {
  const view = await openWorkbench();
  expect(view.container.querySelector('[aria-label="已保存目标"]')?.textContent).toContain(plan.goal);
  const behaviors = view.container.querySelector<HTMLDetailsElement>(".generation-plan-behaviors");
  expect(behaviors?.open).toBe(false);
  expect(behaviors?.querySelector("summary")?.textContent).toContain("历史平铺目标 · 2 项");
  await act(async () => behaviors?.querySelector("summary")?.click());
  expect(behaviors?.open).toBe(true);
  expect(behaviors?.textContent).toContain("输入中文姓名并提交");
  expect(behaviors?.textContent).toContain("报名列表出现这个姓名");
  expect(view.container.querySelector('[aria-label="本次范围说明"]')?.textContent).toContain("不接入真实支付");
  const activity = view.container.querySelector('[data-testid="role-activity"]');
  expect(activity?.textContent).toContain("协调者");
  expect(activity?.textContent).toContain("已完成");
  expect(activity?.textContent).toContain("工程师");
  expect(activity?.textContent).toContain("执行中");
  expect(activity?.textContent).not.toContain("检查者");
  expect(view.container.textContent).not.toContain("确认计划");
  expect(view.requests.every((request) => request.method === "GET")).toBe(true);
});

it("answers one persisted clarification in a linked run while retaining the original request and question", async () => {
  const view = await openWorkbench({ needsInput: true });
  expect(view.container.textContent?.split(question)).toHaveLength(2);
  expect(view.container.querySelector('label[for="followup-prompt"]')?.textContent).toBe("回答澄清问题");
  const input = view.container.querySelector("textarea")!;
  expect(input.getAttribute("aria-describedby")).toContain("clarification-question");
  const answer = "先显示待确认，\n然后由主办方确认。";
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, answer);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
  expect(view.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送回答"]')?.disabled).toBe(false);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  const submissions = view.requests.filter((request) => request.method === "POST");
  expect(submissions).toHaveLength(1);
  expect(submissions[0].body).toEqual({ text: answer, parentRunId: runId, retryOfRunId: null, expectedCurrentRevisionId: null, modelProfileId: profileId, modelConfigVersion: 3 });
  expect(view.container.querySelectorAll(".user-message")).toHaveLength(2);
  expect(view.container.textContent).toContain("创建活动报名演示");
  expect(view.container.textContent?.split(question)).toHaveLength(2);
  expect(view.container.querySelector("textarea")?.value).toBe("");
  expect(view.container.querySelector('[aria-label="已保存目标"]')?.textContent).toContain(plan.goal);
});

it("confirms a lost clarification response with the same parent and key after the latest run changes", async () => {
  const view = await openWorkbench({ needsInput: true, proxyFailureOnce: true });
  const input = view.container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "等待主办方确认");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => view.container.querySelector<HTMLButtonElement>('button[aria-label="发送回答"]')?.click());
  expect(view.container.textContent).toContain("上次提交的结果尚未确认");
  expect(input.value).toBe("等待主办方确认");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "下一次：增加报名详情");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    root?.render(null);
  });
  await view.render();
  const sent = () => view.requests.filter((request) => request.method === "POST");
  expect(sent()).toHaveLength(1);
  expect(view.container.querySelector("textarea")?.value).toBe("下一次：增加报名详情");
  const confirm = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "确认提交结果");
  expect(confirm).toBeDefined();
  await act(async () => confirm?.click());
  expect(sent()).toHaveLength(2);
  expect(sent()[1]).toEqual(sent()[0]);
  expect(sent()[1].body).toMatchObject({ text: "等待主办方确认", parentRunId: runId, retryOfRunId: null });
  expect(view.container.textContent).not.toContain("上次提交的结果尚未确认");
  expect(view.container.querySelector("textarea")?.value).toBe("下一次：增加报名详情");
  expect(view.container.querySelectorAll(".user-message")).toHaveLength(2);
  expect(view.container.textContent?.split(question)).toHaveLength(2);
});

it("keeps an accepted answer running when an older project read still names its needs-input parent", async () => {
  const view = await openWorkbench({ needsInput: true });
  view.holdNextProject();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await act(async () => view.container.querySelector<HTMLButtonElement>('button[aria-label="发送回答"]')?.click());
  expect(view.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  view.holdNextProject(); // Keep the authoritative trailing read slow as well.
  await act(async () => view.releaseProject());
  expect(view.container.querySelector('[data-testid="role-timeline"]')?.textContent).toContain("正在编写应用");
  expect(view.container.querySelector("#clarification-question")).toBeNull();
  expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送需求"]')?.disabled).toBe(true);
  expect(view.container.querySelector('[data-testid="role-activity"]')?.textContent).toContain("工程师");
  await act(async () => view.releaseProject());
  expect(view.container.querySelectorAll(".user-message")).toHaveLength(2);
  expect(view.requests.filter((request) => request.method === "POST")).toHaveLength(1);
});
