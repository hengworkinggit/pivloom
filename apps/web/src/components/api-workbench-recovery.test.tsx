import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readDraft, saveDraft } from "@/lib/drafts";
import type { ProjectDetailResponse, Run, RunEvent } from "@pivloom/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
let root: Root | undefined;
let disposeWorkspace: (() => void) | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  disposeWorkspace?.(); document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
  window.history.replaceState(null, "", "/");
});

const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
const profileId = "438088cb-5fd0-4704-ad57-3b64ed47c55f";
const runId = "74b24d87-1342-4d43-8c4e-f82e766a0633";
const now = "2026-09-22T00:00:00.000Z";
const event = (eventId: string, message: string): RunEvent => ({ schemaVersion: 1, eventId, runId, attempt: 0, type: "tool.output", createdAt: now, payload: { toolName: "bash", toolCallId: "fixture-call", message } });
const sse = (events: RunEvent[]) => new Response(events.map((item) => `id: ${item.eventId}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

async function openWorkbench(stream: (after: string, signal: AbortSignal) => Response | Promise<Response>, options: {
  empty?: boolean;
  autoStart?: boolean;
  post?: (init: RequestInit, project: ProjectDetailResponse, run: Run) => Response | Promise<Response>;
  cancel?: () => Response | Promise<Response>;
} = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: ownerId, email: "owner@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: now };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  localStorage.setItem("pivloom.auth.v1", JSON.stringify({ access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiresAt })}.fixture`, refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user }));
  saveDraft(ownerId, projectId, "下一条中文需求\n保留换行");
  if (options.autoStart) window.history.replaceState(null, "", `/projects/${projectId}?start=1`);
  const run: Run = { id: runId, projectId, state: "building", phase: "implement", attempt: 0, requestText: "创建读书清单", modelProfileId: profileId, modelConfigVersion: 3, modelId: null, baseRevisionId: null, resultRevisionId: null, createdAt: now, deadlineAt: "2026-09-22T00:10:00.000Z", finishedAt: null, cleanupState: "clear", error: null, summary: null };
  const project: ProjectDetailResponse = { project: { id: projectId, title: "读书清单", createdAt: now, updatedAt: now, currentRevisionId: null, activeRunState: null, activeRunPosition: null }, messages: [{ id: "ade806dc-49c3-4b16-950d-6f69c46bb4d8", projectId, runId, kind: "user", content: run.requestText, createdAt: now }], currentRevision: null, activeRun: run, latestRun: run, latestCandidate: null, latestCheck: null, preview: null };
  if (options.empty) { project.messages = []; project.activeRun = null; project.latestRun = null; }
  const requests: { url: string; method: string; at: number; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", at: Date.now(), signal: init?.signal });
    if (url === "https://identity.example.test/auth/v1/user") return Response.json(user);
    if (url === "/api/v1/me") return Response.json({ user: { id: ownerId, name: "Owner", email: user.email } });
    if (url === "/api/v1/model-profiles") return Response.json({ profiles: [{ id: profileId, name: "已验证模型", provider: "openai-completions", baseUrl: "https://provider.example.test/v1", modelId: "fixture-model", configVersion: 3, keyMask: "••••0000", isDefault: true, capabilities: { streaming: "verified", tools: "verified", vision: "unknown" }, lastTest: null, createdAt: now, updatedAt: now }] });
    if (url === `/api/v1/model-profiles/${profileId}/models`) return Response.json({ source: "none", models: [] });
    if (url === `/api/v1/projects/${projectId}`) return Response.json(project);
    if (url === `/api/v1/projects/${projectId}/runs` && options.post) return options.post(init!, project, run);
    if (url === `/api/v1/runs/${runId}/cancel` && options.cancel) return options.cancel();
    if (url === `/api/v1/runs/${runId}`) return Response.json({ run, revision: null, events: [], preview: null });
    if (url.startsWith(`/api/v1/runs/${runId}/events`)) return stream(new URL(url, "https://app.example.test").searchParams.get("after") ?? "0", init!.signal!);
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  const { getApiWorkspace } = await import("@/lib/workspace");
  const workspace = getApiWorkspace(); disposeWorkspace = workspace.dispose; await workspace.initialize();
  const { ApiWorkbench } = await import("./api-workbench");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async () => { await act(async () => root?.render(<ApiWorkbench projectId={projectId} />)); };
  await render();
  return { container, project, run, requests, render,
    streams: () => requests.filter((request) => request.url.includes("/events?")),
    reads: () => requests.filter((request) => request.url === `/api/v1/runs/${runId}`),
  };
}

it("submits a new project's saved first request once after model and project load", async () => {
  const submitted: unknown[] = [];
  const view = await openWorkbench(() => sse([]), { empty: true, autoStart: true, post(init, project, run) {
    submitted.push(JSON.parse(String(init.body)));
    project.activeRun = run; project.latestRun = run;
    return Response.json({ runId, state: "building", eventsUrl: `/api/v1/runs/${runId}/events`, replayed: false }, { status: 202 });
  } });
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ text: "下一条中文需求\n保留换行", expectedCurrentRevisionId: null, modelProfileId: profileId });
  expect(window.location.search).toBe("");
  await view.render();
  expect(submitted).toHaveLength(1);
});

it("two rapid Stop clicks submit one cancellation and keep its pending state visible", async () => {
  let resolveCancel!: (response: Response) => void;
  const pendingCancel = new Promise<Response>((resolve) => { resolveCancel = resolve; });
  let cancellations = 0;
  const view = await openWorkbench(() => sse([]), { cancel: () => { cancellations++; return pendingCancel; } });
  const stop = view.container.querySelector<HTMLButtonElement>('button[aria-label="停止任务"]');
  expect(stop).not.toBeNull();
  act(() => { stop!.click(); stop!.click(); });
  await act(async () => { await Promise.resolve(); });
  expect(cancellations).toBe(1);
  expect(view.container.textContent).toContain("正在停止");
  await act(async () => { resolveCancel(Response.json({ runId, state: "cancel_requested", phase: "implement", cleanupState: "pending" })); });
});

it("a rejected Stop request releases the latch so the user can retry", async () => {
  let cancellations = 0;
  const view = await openWorkbench(() => sse([]), { cancel: () => {
    cancellations++;
    return cancellations === 1
      ? Response.json({ error: { code: "SERVICE_BUSY", message: "稍后重试" } }, { status: 503 })
      : Response.json({ runId, state: "cancel_requested", phase: "implement", cleanupState: "pending" });
  } });
  const stop = () => view.container.querySelector<HTMLButtonElement>('button[aria-label="停止任务"]');
  await act(async () => { stop()?.click(); });
  expect(cancellations).toBe(1);
  expect(stop()?.disabled).toBe(false);
  await act(async () => { stop()?.click(); });
  expect(cancellations).toBe(2);
});

it("stops reconnecting an inaccessible run and keeps the user's unsent draft", async () => {
  const view = await openWorkbench(() => Response.json({ error: { code: "NOT_FOUND", message: "任务不可访问", retryable: false, requestId: "fixture" } }, { status: 404 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(view.streams()).toHaveLength(1);
  expect(view.container.querySelector(".generation-connection[role=status]")?.textContent).toContain("已停止重连");
  expect(readDraft(ownerId, projectId)).toBe("下一条中文需求\n保留换行");
  expect(view.requests.every((request) => request.method === "GET")).toBe(true);
  Object.assign(view.run, { state: "failed", cleanupState: "pending", finishedAt: now, error: { code: "BUILD_FAILED", message: "构建失败", retryable: true } });
  view.project.activeRun = null;
  const retry = view.container.querySelector<HTMLButtonElement>(".generation-connection button");
  expect(retry?.textContent).toBe("重新读取任务");
  await act(async () => retry?.click());
  expect(view.container.textContent).toContain("正在清理执行资源");
  view.run.cleanupState = "confirmed";
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送需求"]')?.disabled).toBe(false);
  expect(view.streams()).toHaveLength(1);
});

it("reconnects with bounded jittered backoff, resumes its cursor, and renders replayed output once", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.75);
  const cursors: string[] = [];
  let live: ReadableStreamDefaultController<Uint8Array> | undefined;
  const view = await openWorkbench((after, signal) => {
    cursors.push(after);
    if (cursors.length === 1) return sse([event("9007199254740993", "第一批真实输出")]);
    if (cursors.length !== 5) throw new TypeError("Fixture connection unavailable");
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      live = controller;
      for (const item of [event("9007199254740993", "第一批真实输出"), event("9007199254740994", "第二批真实输出")]) {
        controller.enqueue(new TextEncoder().encode(`id: ${item.eventId}\ndata: ${JSON.stringify(item)}\n\n`));
      }
      signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
    } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });
  expect(view.container.querySelector(".generation-connection[role=status]")?.textContent).toContain("实时连接暂不可用");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(cursors).toEqual(["0"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(cursors).toEqual(["0", "9007199254740993"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100 + 4200 + 8000); });
  expect(view.streams().map((request) => request.at - view.streams()[0].at)).toEqual([0, 1050, 3150, 7350, 15350]);
  expect(cursors.slice(1)).toEqual(Array(4).fill("9007199254740993"));
  expect([...view.container.querySelectorAll(".generation-event-log pre")].map((item) => item.textContent)).toEqual(["第一批真实输出", "第二批真实输出"]);
  expect(view.container.querySelector<HTMLDetailsElement>(".generation-event-log")?.open).toBe(false);
  expect(view.container.querySelector(".generation-connection[role=status]")?.textContent).toContain("已连接实时执行记录");
  await act(async () => { live!.close(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
  expect(cursors.at(-1)).toBe("9007199254740994");
  expect(view.streams()).toHaveLength(6);
  expect(view.container.querySelectorAll(".user-message")).toHaveLength(1);
  expect(view.requests.every((request) => request.method === "GET")).toBe(true);
});

it("falls back to an authoritative run read when an event is malformed", async () => {
  const view = await openWorkbench(() => new Response("id: 1\ndata: {broken-json}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  expect(view.reads().length).toBeGreaterThan(1);
  expect(view.container.querySelector(".generation-connection[role=status]")?.textContent).toContain("实时连接暂不可用");
  expect(view.container.querySelector('[data-testid="role-timeline"]')?.textContent).toContain("正在编写应用");
  expect(view.container.querySelector(".generation-event-log")).toBeNull();
  expect(view.requests.every((request) => request.method === "GET")).toBe(true);
});

it("leaves only the subscription and reopens the known run without another generation request", async () => {
  let cancellations = 0;
  const view = await openWorkbench(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const item = event("20", "后台正在运行");
      controller.enqueue(new TextEncoder().encode(`id: 20\ndata: ${JSON.stringify(item)}\n\n`));
    },
    cancel() { cancellations += 1; },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  await act(async () => root?.render(null));
  expect(view.streams()[0].signal?.aborted).toBe(true);
  expect(cancellations).toBe(1);
  const requestsAfterLeaving = view.requests.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(view.requests).toHaveLength(requestsAfterLeaving);
  view.run.phase = "build";
  await view.render();
  expect(view.container.querySelector('[data-testid="role-timeline"]')?.textContent).toContain("正在检查与构建");
  expect(view.container.querySelectorAll(".user-message")).toHaveLength(1);
  expect(view.container.querySelectorAll(".generation-event-log pre")).toHaveLength(1);
  expect(view.container.querySelector("textarea")?.value).toBe("下一条中文需求\n保留换行");
  expect(view.streams()).toHaveLength(2);
  expect(view.requests.every((request) => request.method === "GET")).toBe(true);
});

it.each(["network loss", "proxy 502"])("keeps an unknown submission after %s across reopening and confirms only its original body and key", async (failure) => {
  const submitted: { key: string | null; body: unknown }[] = [];
  const view = await openWorkbench(() => sse([]), { empty: true, post(init, project, run) {
    submitted.push({ key: new Headers(init.headers).get("Idempotency-Key"), body: JSON.parse(String(init.body)) });
    project.activeRun = run; project.latestRun = run;
    project.messages = [{ id: "ade806dc-49c3-4b16-950d-6f69c46bb4d8", projectId, runId, kind: "user", content: "下一条中文需求\n保留换行", createdAt: now }];
    if (submitted.length === 1) {
      if (failure === "proxy 502") return new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
      throw new TypeError("Accepted response lost in transit");
    }
    return Response.json({ runId, state: "building", eventsUrl: `/api/v1/runs/${runId}/events`, replayed: true }, { status: 202 });
  } });
  await act(async () => view.container.querySelector<HTMLButtonElement>('button[aria-label="发送需求"]')?.click());
  expect(view.container.textContent).toContain("上次提交的结果尚未确认");
  const input = view.container.querySelector("textarea")!;
  expect(input.value).toBe("下一条中文需求\n保留换行");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "正在编辑的新草稿");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    root?.render(null);
  });
  await view.render();
  expect(submitted).toHaveLength(1);
  expect(view.container.querySelector("textarea")?.value).toBe("正在编辑的新草稿");
  const confirm = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "确认提交结果");
  expect(confirm).toBeDefined();
  await act(async () => confirm?.click());
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(submitted[0].key).toMatch(/^[a-f\d-]{36}$/);
  expect(submitted[0].body).toMatchObject({ text: "下一条中文需求\n保留换行", modelConfigVersion: 3 });
  expect(view.container.textContent).not.toContain("上次提交的结果尚未确认");
  expect(view.container.querySelector("textarea")?.value).toBe("正在编辑的新草稿");
  await act(async () => root?.render(null));
  await view.render();
  expect(view.container.querySelectorAll(".user-message")).toHaveLength(1);
  expect(submitted).toHaveLength(2);
});

it.each(["PROJECT_BUSY", "STALE_BASE", "SERVICE_BUSY"])("keeps the draft after a definite %s rejection without queuing or replaying it", async (code) => {
  const view = await openWorkbench(() => sse([]), { empty: true, post() {
    return Response.json({ error: { code, message: "当前修改无法开始，请稍后重新发送。", retryable: true, requestId: "fixture" } }, { status: code === "SERVICE_BUSY" ? 503 : 409 });
  } });
  await act(async () => view.container.querySelector<HTMLButtonElement>('button[aria-label="发送需求"]')?.click());
  expect(view.container.querySelector("textarea")?.value).toBe("下一条中文需求\n保留换行");
  expect(view.container.textContent).toContain("当前修改无法开始，请稍后重新发送。");
  expect(view.container.textContent).not.toContain("上次提交的结果尚未确认");
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(10_000); });
  expect(view.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(readDraft(ownerId, projectId)).toBe("下一条中文需求\n保留换行");
});
