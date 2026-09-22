import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { saveDraft, readDraft } from "@/lib/drafts";
import type { ProjectDetailResponse, Run, Revision } from "@pivloom/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
let root: Root | undefined;
let disposeWorkspace: (() => void) | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  disposeWorkspace?.(); document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
});

it.each(["normal", "snapshot failure", "slow run read", "accepted during snapshot", "completion between reads", "accepted after newer run", "stale terminal snapshot", "stale terminal project"] as const)("retains drafts and reads the accepted run without duplicate submission: %s", async (scenario) => {
  const snapshotFailsOnce = scenario === "snapshot failure";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
  const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
  const profileId = "438088cb-5fd0-4704-ad57-3b64ed47c55f";
  const runId = "74b24d87-1342-4d43-8c4e-f82e766a0633";
  const revisionId = "753f8374-d88f-4399-b366-0aa544d03a2f";
  const now = "2026-09-22T00:00:00.000Z";
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: ownerId, email: "owner@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: now };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  localStorage.setItem("pivloom.auth.v1", JSON.stringify({ access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiresAt })}.fixture`, refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user }));
  saveDraft(ownerId, projectId, "创建中文读书清单");
  const run: Run = { id: runId, projectId, state: "building", phase: "implement", attempt: 0, requestText: "创建中文读书清单", modelProfileId: profileId, modelConfigVersion: 3, modelId: null, baseRevisionId: null, resultRevisionId: null, createdAt: now, deadlineAt: "2026-09-22T00:10:00.000Z", finishedAt: null, cleanupState: "clear", error: null, summary: null };
  const candidate: Revision = { id: revisionId, projectId, runId, revisionNo: 1, attempt: 0, sourceHash: "a".repeat(64), templateVersion: "fixture-v1", buildStatus: "passed", status: "candidate", createdAt: now, manifest: [{ path: "src/App.tsx", bytes: 31, sha256: "b".repeat(64) }] };
  const project: ProjectDetailResponse = { project: { id: projectId, title: "读书清单", createdAt: now, updatedAt: now, currentRevisionId: null }, messages: [], currentRevision: null, activeRun: null, latestRun: null, latestCandidate: null, latestCheck: null, preview: null };
  const requests: { body: unknown; key: string | null }[] = [];
  let eventConnections = 0;
  let snapshotRequests = 0;
  let holdSnapshot = false;
  let holdLatestSnapshot = false;
  let releaseLatestSnapshot: (() => void) | undefined;
  let staleSnapshotOnce: ProjectDetailResponse | null = null;
  let staleSnapshotReads = 1;
  let staleRunOnce: Run | null = null;
  let holdRun = scenario === "slow run read";
  let otherTabRun: Run | null = null;
  let releaseRead: (() => void) | undefined;
  let failNextSnapshot = false;
  let accept: (response: Response) => void = () => { throw new Error("No request waiting"); };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://identity.example.test/auth/v1/user") return Response.json(user);
    if (url === "/api/v1/me") return Response.json({ user: { id: ownerId, name: "Owner", email: user.email } });
    if (url === "/api/v1/model-profiles") return Response.json({ profiles: [{ id: profileId, name: "真实配置", provider: "openai-completions", baseUrl: "https://provider.example.test/v1", modelId: "fixture-model", configVersion: 3, keyMask: "••••0000", isDefault: true, capabilities: { streaming: "verified", tools: "verified", vision: "unknown" }, lastTest: null, createdAt: now, updatedAt: now }] });
    if (url === `/api/v1/model-profiles/${profileId}/models`) return Response.json({ source: "none", models: [] });
    if (url === `/api/v1/projects/${projectId}`) {
      snapshotRequests += 1;
      if (holdLatestSnapshot) {
        holdLatestSnapshot = false;
        return new Promise<Response>((resolve) => { releaseLatestSnapshot = () => resolve(Response.json(project)); });
      }
      if (staleSnapshotOnce) {
        const response = Response.json(staleSnapshotOnce);
        if (--staleSnapshotReads === 0) staleSnapshotOnce = null;
        return response;
      }
      if (holdSnapshot) {
        holdSnapshot = false;
        const previousSnapshot = Response.json(project);
        return new Promise<Response>((resolve) => { releaseRead = () => resolve(previousSnapshot); });
      }
      if (failNextSnapshot) {
        failNextSnapshot = false;
        return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "状态服务暂不可用", retryable: true, requestId: "fixture" } }, { status: 503 });
      }
      return Response.json(project);
    }
    if (url === `/api/v1/projects/${projectId}/runs`) {
      requests.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("Idempotency-Key") });
      return new Promise<Response>((resolve) => { accept = resolve; });
    }
    if (url === `/api/v1/runs/${runId}`) {
      const response = Response.json({ run: staleRunOnce ?? run, revision: project.latestCandidate, events: [], preview: null });
      staleRunOnce = null;
      if (holdRun) return new Promise<Response>((resolve) => { releaseRead ??= () => resolve(response); });
      return response;
    }
    if (otherTabRun && url === `/api/v1/runs/${otherTabRun.id}`) return Response.json({ run: otherTabRun, revision: null, events: [], preview: null,
      roles: [{ id: "8f867b3d-0da2-430d-b3e9-cbf72d51e615", runId: otherTabRun.id, role: "coordinator", attempt: 0,
        sessionId: "9e9ec313-c626-45b3-836e-d3dfb1c21459", state: "succeeded", predecessorId: null, startedAt: now, finishedAt: now }] });
    if (url.startsWith(`/api/v1/runs/${runId}/events`)) {
      eventConnections += 1;
      return new Response(": heartbeat\n\n", { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url === `/api/v1/revisions/${revisionId}/files`) return Response.json({ revisionId, sourceHash: candidate.sourceHash, files: candidate.manifest });
    if (url.startsWith(`/api/v1/revisions/${revisionId}/file?`)) return Response.json({ revisionId, path: "src/App.tsx", content: 'export const title = "读书清单";', sha256: "b".repeat(64) });
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  const { getApiWorkspace } = await import("@/lib/workspace");
  const workspace = getApiWorkspace(); disposeWorkspace = workspace.dispose; await workspace.initialize();
  const { ApiWorkbench } = await import("./api-workbench");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<ApiWorkbench projectId={projectId} />));
  const input = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!input) throw new Error("The workbench composer did not render");
  const submit = () => container.querySelector<HTMLButtonElement>('button[aria-label="发送需求"]');
  expect(submit()?.disabled).toBe(false);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })); });
  expect(requests).toEqual([]);
  if (scenario === "accepted during snapshot") {
    holdSnapshot = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
  }
  const snapshotsBeforeAcceptance = snapshotRequests;
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(requests[0]).toMatchObject({ body: { text: "创建中文读书清单", expectedCurrentRevisionId: null, modelProfileId: profileId, modelConfigVersion: 3 } });
  expect(requests[0].key).toMatch(/^[a-f\d-]{36}$/);
  expect(input.value).toBe("创建中文读书清单");
  expect(readDraft(ownerId, projectId)).toBe("创建中文读书清单");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "下一条：增加作者筛选");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  project.activeRun = run; project.latestRun = run;
  holdLatestSnapshot = scenario === "accepted after newer run";
  failNextSnapshot = snapshotFailsOnce;
  project.messages = [{ id: "ade806dc-49c3-4b16-950d-6f69c46bb4d8", projectId, runId, kind: "user", content: run.requestText, createdAt: now }];
  await act(async () => { accept(Response.json({ runId, state: "accepted", eventsUrl: `/api/v1/runs/${runId}/events`, replayed: false }, { status: 202 })); });
  expect(input.value).toBe("下一条：增加作者筛选");
  expect(readDraft(ownerId, projectId)).toBe("下一条：增加作者筛选");
  expect(submit()?.disabled).toBe(true);
  expect(input.disabled).toBe(false);
  if (scenario === "accepted after newer run") {
    // The accepted R1 completes before this tab can read it. Another tab then
    // completes R2, so the first successful project snapshot already names R2.
    Object.assign(run, { state: "failed", phase: "build", cleanupState: "confirmed", finishedAt: now,
      error: { code: "BUILD_FAILED", message: "R1 已结束", retryable: true } });
    otherTabRun = { ...run, id: "916c579b-764e-4097-96a9-5b805a3bd0e3", requestText: "其他标签发起的修改",
      error: { code: "BUILD_FAILED", message: "其他标签中的任务构建失败", retryable: true } };
    project.activeRun = null; project.latestRun = otherTabRun;
    project.messages.push({ id: "254df0db-cfce-46d6-bcaf-18821324b24a", projectId, runId: otherTabRun.id, kind: "user", content: otherTabRun.requestText, createdAt: now });
    if (!releaseLatestSnapshot) throw new Error("Expected a delayed first project snapshot");
    await act(async () => { releaseLatestSnapshot!(); });
    expect(container.textContent).toContain("其他标签中的任务构建失败");
    expect(container.textContent).not.toContain("需求已接收，正在读取任务状态。");
    expect(container.querySelectorAll(".user-message")).toHaveLength(2);
    expect(submit()?.disabled).toBe(false);
    expect(input.value).toBe("下一条：增加作者筛选");
    expect(requests).toHaveLength(1);
    expect(container.querySelector('[data-testid="role-activity"]')?.textContent).toContain("协调者");
    return;
  }
  if (snapshotFailsOnce) await act(async () => { window.dispatchEvent(new Event("focus")); });
  if (scenario === "slow run read" || scenario === "accepted during snapshot") {
    if (scenario === "accepted during snapshot") expect(snapshotRequests).toBe(snapshotsBeforeAcceptance);
    const requestsWhileReading = snapshotRequests;
    await act(async () => { await vi.advanceTimersByTimeAsync(7500); });
    // Polls coalesce behind one in-flight snapshot instead of starving it.
    expect(snapshotRequests).toBe(requestsWhileReading);
    if (!releaseRead) throw new Error("Expected the HTTP fixture to hold one slow read");
    holdRun = false;
    await act(async () => { releaseRead!(); });
    expect(container.textContent).toContain("正在编写应用");
    expect(requests).toHaveLength(1);
  }
  expect(container.querySelectorAll(".user-message")).toHaveLength(1);

  const executingSnapshot = structuredClone(project);
  const completesBetweenReads = scenario === "completion between reads";
  if (completesBetweenReads) staleSnapshotOnce = structuredClone(project);
  Object.assign(run, { state: "failed", phase: "review", cleanupState: completesBetweenReads ? "confirmed" : "pending", resultRevisionId: revisionId, finishedAt: now, error: { code: "CHECK_BLOCKED", message: "检查能力尚未就绪", retryable: false } });
  project.activeRun = null; project.latestCandidate = candidate;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(container.textContent).toContain("尚未检查");
  expect(container.textContent).not.toContain("检查通过");
  const connectionsAtTerminal = eventConnections;
  if (!completesBetweenReads) {
    expect(submit()?.disabled).toBe(true);
    expect(container.textContent).toContain("正在清理执行资源");
    run.cleanupState = "confirmed";
    // No focus/reload/SSE event: the real polling boundary must observe cleanup.
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  }
  expect(submit()?.disabled).toBe(false);
  expect(input.value).toBe("下一条：增加作者筛选");
  expect(eventConnections).toBe(connectionsAtTerminal);
  if (scenario === "stale terminal snapshot" || scenario === "stale terminal project") {
    staleSnapshotOnce = executingSnapshot;
    if (scenario === "stale terminal snapshot") staleRunOnce = executingSnapshot.activeRun;
    else staleSnapshotReads = 2; // Both project reads predate the saved candidate.
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(container.querySelector('[data-testid="run-result"]')?.textContent).toContain("候选已保存 · 尚未检查");
    expect(container.querySelector('[data-testid="role-timeline"]')?.textContent).toContain("本次任务已结束");
    expect(submit()?.disabled).toBe(false);
    expect(eventConnections).toBe(connectionsAtTerminal);
    staleRunOnce = { ...run, cleanupState: "pending" };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(submit()?.disabled).toBe(false);
    expect(container.textContent).not.toContain("正在清理执行资源");
  }
  await act(async () => { container.querySelector<HTMLButtonElement>('#code-tab')?.click(); });
  expect(container.querySelector('[data-testid="source-viewer"]')?.textContent).toContain('export const title = "读书清单";');
  expect(container.querySelector('[data-testid="source-viewer"]')?.textContent).toContain("只读");

  project.preview = { state: "ready", revisionId, sourceHash: candidate.sourceHash, url: `${window.location.origin}/unsafe-preview`, expiresAt: null, error: null };
  await act(async () => { window.dispatchEvent(new Event("focus")); container.querySelector<HTMLButtonElement>('#preview-tab')?.click(); });
  expect(container.querySelector('iframe[title="应用预览"]')).toBeNull();
  project.preview.url = "https://preview.example.test/app/";
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  const frame = container.querySelector<HTMLIFrameElement>('iframe[title="应用预览"]');
  expect(frame?.getAttribute("src")).toBe("https://preview.example.test/app/");
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(container.querySelector('iframe[title="应用预览"]')).toBe(frame);

  if (scenario === "normal") {
    otherTabRun = { ...run, id: "916c579b-764e-4097-96a9-5b805a3bd0e3", requestText: "其他标签发起的修改", resultRevisionId: null,
      error: { code: "BUILD_FAILED", message: "其他标签中的任务构建失败", retryable: true } };
    project.latestRun = otherTabRun;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(container.textContent).toContain("其他标签中的任务构建失败");
    expect(container.textContent).not.toContain("需求已接收，正在读取任务状态。");
    expect(submit()?.disabled).toBe(false);
    expect(input.value).toBe("下一条：增加作者筛选");
    expect(requests).toHaveLength(1);
  }
});
