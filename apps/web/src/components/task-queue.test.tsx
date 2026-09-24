import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectDetailResponse, Run, TaskListItem } from "@pivloom/contracts";
import { saveDraft } from "@/lib/drafts";
import { summarizeTasks, taskDetailCopy, taskStateCopy, taskTone } from "@/lib/task-queue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
let root: Root | undefined;
let disposeWorkspace: (() => void) | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; disposeWorkspace?.();
  document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks();
});

const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
const profileId = "438088cb-5fd0-4704-ad57-3b64ed47c55f";
const runId = "74b24d87-1342-4d43-8c4e-f82e766a0633";
const nextRunId = "c1b0f2a6-4f1c-4d3e-8a11-2b7c9d0e5f44";
const now = "2026-09-22T00:00:00.000Z";

function taskFixture(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    runId, projectId, projectTitle: "读书清单", state: "queued", phase: "plan",
    queuedAt: now, queuePosition: 2, cancelable: true, modelProfileId: profileId,
    modelConfigVersion: 3, modelId: null, error: null, ...overrides,
  };
}

// The real workbench, workspace adapter, draft store and API adapters run here;
// only HTTP is a fixture. This is not a browser or model E2E.
async function openWorkbench(options: { run: Run; tasks: TaskListItem[] }) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: ownerId, email: "owner@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: now };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  localStorage.setItem("pivloom.auth.v1", JSON.stringify({
    access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiresAt })}.fixture`,
    refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user,
  }));
  const project: ProjectDetailResponse = {
    project: { id: projectId, title: "读书清单", createdAt: now, updatedAt: now, currentRevisionId: null, activeRunState: null, activeRunPosition: null },
    messages: [], currentRevision: null, activeRun: options.run, latestRun: options.run,
    latestCandidate: null, latestCheck: null, preview: null,
  };
  const requests: { url: string; method: string; body: unknown }[] = [];
  const submitted: unknown[] = [];
  let queuedRun = options.run;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "https://identity.example.test/auth/v1/user") return Response.json(user);
    if (url.startsWith("https://identity.example.test/auth/v1/logout")) return new Response(null, { status: 204 });
    if (url === "/api/v1/me") return Response.json({ user: { id: ownerId, name: "Owner", email: user.email } });
    if (url === "/api/v1/tasks") return Response.json({ tasks: options.tasks });
    if (url === "/api/v1/model-profiles") return Response.json({ profiles: [{
      id: profileId, name: "已验证模型", provider: "openai-completions", baseUrl: "https://provider.example.test/v1",
      modelId: "fixture-model", configVersion: 3, keyMask: "••••0000", isDefault: true,
      capabilities: { streaming: "verified", tools: "verified", vision: "verified" }, lastTest: null, createdAt: now, updatedAt: now,
    }] });
    if (url === `/api/v1/model-profiles/${profileId}/models`) return Response.json({ source: "none", models: [] });
    if (url === `/api/v1/projects/${projectId}`) return Response.json(project);
    if (url === `/api/v1/projects/${projectId}/revisions`) return Response.json({ projectId, currentRevisionId: null, revisions: [] });
    if (url === `/api/v1/projects/${projectId}/runs` && method === "POST") {
      submitted.push(JSON.parse(String(init!.body)));
      queuedRun = { ...options.run, id: nextRunId, state: "queued", phase: "plan", requestText: "继续添加搜索" };
      return Response.json({ runId: nextRunId, state: "queued", eventsUrl: `/api/v1/runs/${nextRunId}/events`, replayed: false }, { status: 202 });
    }
    if (url === `/api/v1/runs/${runId}` || url === `/api/v1/runs/${nextRunId}`)
      return Response.json({ run: queuedRun.id === nextRunId && url.endsWith(nextRunId) ? queuedRun : options.run, roles: [], revision: null, events: [], preview: null });
    if (url.startsWith(`/api/v1/runs/${runId}/cancel`) || url.startsWith(`/api/v1/runs/${nextRunId}/cancel`)) {
      const cancelledId = url.includes(nextRunId) ? nextRunId : runId;
      return Response.json({ runId: cancelledId, state: "cancelled", phase: "plan", cleanupState: "clear" });
    }
    if (url.startsWith("/api/v1/runs/") && url.includes("/events?"))
      return new Response(new ReadableStream({ start(controller) {
        init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } }, { once: true });
      } }), { headers: { "Content-Type": "text/event-stream" } });
    throw new Error(`Unexpected fixture endpoint: ${method} ${url}`);
  });
  const { getApiWorkspace } = await import("@/lib/workspace");
  const workspace = getApiWorkspace(); disposeWorkspace = workspace.dispose; await workspace.initialize();
  const { ApiWorkbench } = await import("./api-workbench");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<ApiWorkbench projectId={projectId} />));
  await act(async () => { await vi.waitFor(() => expect(container.textContent).not.toContain("正在打开项目")); });
  return { container, requests, submitted };
}

it("labels a persisted queue position and lets the owner cancel the queued task", async () => {
  const queuedRun: Run = { id: runId, projectId, state: "queued", phase: "plan", attempt: 0, requestText: "添加搜索",
    modelProfileId: profileId, modelConfigVersion: 3, modelId: null, baseRevisionId: null, resultRevisionId: null,
    createdAt: now, deadlineAt: "2026-09-22T00:30:00.000Z", finishedAt: null, cleanupState: "clear", error: null, summary: null };
  const view = await openWorkbench({ run: queuedRun, tasks: [taskFixture()] });

  expect(view.container.textContent).toContain("已排队（第 2 位），资源可用后自动开始");
  const stop = view.container.querySelector<HTMLButtonElement>('button[aria-label="取消排队"]');
  expect(stop?.textContent).toContain("取消排队");
  expect(view.container.querySelector('[data-testid="header-task-count"]')?.textContent).toBe("1");

  await act(async () => view.container.querySelector<HTMLButtonElement>('[aria-label="我的任务"]')?.click());
  const tasksDrawer = view.container.querySelector(".a-workbench-drawer");
  expect(tasksDrawer?.textContent).toContain("排队中 · 第 2 位");
  expect(tasksDrawer?.textContent).toContain("资源可用后会自动开始，不需要重新提交。");

  await act(async () => {
    view.container.querySelector<HTMLButtonElement>('.a-workbench-drawer button[aria-label^="取消排队任务"]')?.click();
  });
  await act(async () => { await vi.waitFor(() => expect(view.requests.some((request) => request.url === `/api/v1/runs/${runId}/cancel`)).toBe(true)); });
  expect(view.submitted).toHaveLength(0);
});

it("accepts the next request while a task is running instead of blocking the composer", async () => {
  const running: Run = { id: runId, projectId, state: "building", phase: "implement", attempt: 0, requestText: "添加搜索",
    modelProfileId: profileId, modelConfigVersion: 3, modelId: null, baseRevisionId: null, resultRevisionId: null,
    createdAt: now, deadlineAt: "2026-09-22T00:30:00.000Z", finishedAt: null, cleanupState: "clear", error: null, summary: null };
  saveDraft(ownerId, projectId, "继续添加搜索");
  const view = await openWorkbench({ run: running, tasks: [taskFixture({ state: "building", phase: "implement", queuePosition: null })] });

  expect(view.container.textContent).toContain("正在执行；下一条需求会加入队列");
  const submit = view.container.querySelector<HTMLButtonElement>('button[aria-label="发送需求"]');
  expect(submit?.disabled).toBe(false);
  await act(async () => submit?.click());
  await act(async () => { await vi.waitFor(() => expect(view.submitted).toHaveLength(1)); });
  expect(view.submitted[0]).toMatchObject({ text: "继续添加搜索", expectedCurrentRevisionId: null, modelProfileId: profileId });
});

it("keeps queue copy and summaries driven by the reported task state", () => {
  expect(taskTone("queued")).toBe("waiting");
  expect(taskTone("cancel_requested")).toBe("stopping");
  expect(taskStateCopy(taskFixture())).toEqual({ zh: "排队中 · 第 2 位", en: "Queued · position 2" });
  expect(taskStateCopy(taskFixture({ queuePosition: null })).zh).toBe("排队中");
  expect(taskStateCopy(taskFixture({ state: "building", phase: "implement" })).zh).toBe("执行中");
  expect(taskDetailCopy(taskFixture({ queuePosition: null })).zh).toContain("资源可用后会自动开始");
  expect(taskDetailCopy(taskFixture({ state: "failed", error: { code: "GENERATION_FAILED", message: "生成失败", retryable: true } })).zh).toBe("生成失败");
  expect(summarizeTasks([
    taskFixture(),
    taskFixture({ runId: nextRunId, state: "building", queuePosition: null }),
    taskFixture({ runId: "0d1f0b6c-2c3f-4c4a-9b1c-8b2e5f7a6d10", state: "completed", cancelable: false }),
  ])).toMatchObject({ open: 2, queued: 1, position: 2 });
});
