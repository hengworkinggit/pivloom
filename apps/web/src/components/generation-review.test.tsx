import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Check, Revision, Run } from "@pivloom/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
let root: Root | undefined;
let disposeWorkspace: (() => void) | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; disposeWorkspace?.();
  document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
});

const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
const runId = "74b24d87-1342-4d43-8c4e-f82e766a0633";
const revisionId = "09d00eb6-661f-4ed7-9e96-a46f4e2c800e";
const artifactId = "9d3a8a11-f37b-41ca-8c21-b5657085b494";
const now = "2026-09-22T00:00:00.000Z";
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqqEAAAAASUVORK5CYII="), (letter) => letter.charCodeAt(0));

// Real workbench, Supabase client and API adapters; only external HTTP, routing
// and browser object URLs are fixtures. These tests are not browser/model E2E.
async function openWorkbench(options: { verdict?: Check["verdict"]; unchecked?: boolean; mismatch?: boolean; screenshotDenied?: boolean; finalScreenshot?: boolean; reviewing?: boolean; previousCurrent?: boolean; attempt?: number; grouped?: boolean } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  const created = vi.fn(() => "blob:review-fixture"), revoked = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = created; static revokeObjectURL = revoked; });
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: ownerId, email: "owner@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: now };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  localStorage.setItem("pivloom.auth.v1", JSON.stringify({ access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiresAt })}.fixture`, refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user }));
  const verdict = options.verdict ?? "passed";
  const revision: Revision = { id: revisionId, projectId, runId, revisionNo: options.previousCurrent ? 2 : 1, attempt: options.attempt ?? 0, sourceHash: "a".repeat(64), templateVersion: "fixture-v1", buildStatus: "passed", status: options.unchecked || options.reviewing ? "candidate" : verdict === "passed" ? "accepted" : verdict === "failed" ? "rejected" : "candidate", createdAt: now, manifest: [] };
  const currentRevision: Revision | null = options.previousCurrent
    ? { ...revision, id: "810a101e-e123-4dad-90a7-cbbfae291903", runId: "4190c6a4-14f8-48bd-a9b7-0fdad7b02372", revisionNo: 1, sourceHash: "c".repeat(64), status: "accepted" }
    : revision.status === "accepted" ? revision : null;
  const check: Check | null = options.unchecked ? null : {
    id: "29b07531-d902-4fa0-b1b8-65d52c908cbb", runId, roleRunId: "e861ce71-b069-44df-b13b-7c462265d8ee", attempt: options.attempt ?? 0,
    revisionId, sourceHash: options.mismatch ? "b".repeat(64) : revision.sourceHash,
    sandboxId: "fixture-sandbox", browserSessionId: "fixture-review-session", verdict,
    items: [{ behaviorId: "B01", verdict, expected: "报名记录出现在列表中", actual: verdict === "passed" ? "提交后列表出现了张小雨" : verdict === "failed" ? "提交后没有新增记录" : "浏览器无法连接到候选页面",
      observationEventIds: ["17a2b292-e2a0-4296-a841-f6a2d036e94a"], screenshotIds: options.finalScreenshot ? [] : [artifactId], reproSteps: ["填写中文姓名", "提交报名"] }],
    summary: verdict === "passed" ? "报名提交符合已保存的行为目标。" : verdict === "failed" ? "报名提交尚未达到预期。" : "页面无法访问，暂不能判断行为。",
    artifacts: [{ id: artifactId, mimeType: "image/png", sha256: "101070e7bd1de3933a1fee8c8ecc791c7a58eacbae4d9d41ab8e1d7e17cd4326" }], createdAt: now,
  };
  if (options.grouped && check) {
    check.items = ["B01", "B02", "B03", "B04", "B05", "B06"].map((behaviorId) => ({
      behaviorId, verdict: behaviorId === "B04" ? "failed" : "passed",
      expected: `完成 ${behaviorId}`, actual: behaviorId === "B04" ? "实际失败" : `实际完成 ${behaviorId}`,
      observationEventIds: ["17a2b292-e2a0-4296-a841-f6a2d036e94a"], screenshotIds: [], reproSteps: ["打开并操作页面"],
    }));
    check.groups = [
      { id: "G1", title: "数值运算", behaviorIds: ["B01", "B02"], verdict: "passed", requiredCount: 2, passedCount: 2, failedCount: 0, blockedCount: 0 },
      { id: "G2", title: "输入键盘", behaviorIds: ["B03"], verdict: "passed", requiredCount: 1, passedCount: 1, failedCount: 0, blockedCount: 0 },
      { id: "G3", title: "错误恢复", behaviorIds: ["B04"], verdict: "failed", requiredCount: 1, passedCount: 0, failedCount: 1, blockedCount: 0 },
      { id: "G4", title: "结果历史", behaviorIds: ["B05"], verdict: "passed", requiredCount: 1, passedCount: 1, failedCount: 0, blockedCount: 0 },
      { id: "G5", title: "视觉布局", behaviorIds: ["B06"], verdict: "passed", requiredCount: 1, passedCount: 1, failedCount: 0, blockedCount: 0 },
    ];
  }
  const run: Run = { id: runId, projectId, state: options.reviewing ? "verifying" : verdict === "passed" && !options.unchecked ? "completed" : verdict === "failed" ? "needs_changes" : "failed", phase: "review", attempt: options.attempt ?? 0, requestText: "创建报名页", modelProfileId: "438088cb-5fd0-4704-ad57-3b64ed47c55f", modelConfigVersion: 1, modelId: null, baseRevisionId: null, resultRevisionId: revisionId, createdAt: now, deadlineAt: now, finishedAt: options.reviewing ? null : now, cleanupState: "clear", error: options.unchecked || verdict === "blocked" ? { code: "CHECK_BLOCKED", message: "检查尚未完成", retryable: false } : null, summary: "已保存结果" };
  const preview = { state: "expired", revisionId, sourceHash: revision.sourceHash, url: null, expiresAt: now, error: null };
  const project = { project: { id: projectId, title: "报名页", createdAt: now, updatedAt: now, currentRevisionId: currentRevision?.id ?? null }, messages: [], currentRevision, latestCandidate: revision.status !== "accepted" ? revision : null, activeRun: options.reviewing ? run : null, latestRun: run, latestCheck: options.reviewing ? null : check, preview };
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const requests: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (url === "https://identity.example.test/auth/v1/user") return Response.json(user);
    if (url.startsWith("https://identity.example.test/auth/v1/logout")) return new Response(null, { status: 204 });
    if (url === "/api/v1/me") return Response.json({ user: { id: ownerId, name: "Owner", email: user.email } });
    if (url === "/api/v1/model-profiles") return Response.json({ profiles: [] });
    if (url === `/api/v1/projects/${projectId}`) return Response.json(project);
    if (url === `/api/v1/projects/${projectId}/revisions`) return Response.json({ projectId,
      currentRevisionId: currentRevision?.id ?? null,
      revisions: currentRevision && currentRevision.id !== revision.id ? [revision, currentRevision] : [revision] });
    if (url === `/api/v1/runs/${runId}`) return Response.json({ run, roles: [], revision, events: [], preview });
    if (url === `/api/v1/revisions/${revisionId}/check`) return Response.json({ check: project.latestCheck });
    if (currentRevision && url === `/api/v1/revisions/${currentRevision.id}/check`) return Response.json({ check: null });
    if (currentRevision && url === `/api/v1/projects/${projectId}/preview?revisionId=${currentRevision.id}`) return Response.json({ preview: { ...preview, revisionId: currentRevision.id, sourceHash: currentRevision.sourceHash } });
    if (url.startsWith(`/api/v1/runs/${runId}/events?`)) return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
    if (check && url === `/api/v1/checks/${check.id}/artifacts/${artifactId}`) return options.screenshotDenied
      ? Response.json({ error: { code: "NOT_FOUND", message: "Not available", retryable: false, requestId: "fixture" } }, { status: 404 })
      : new Response(png, { headers: { "Content-Type": "image/png" } });
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  const { getApiWorkspace } = await import("@/lib/workspace");
  const workspace = getApiWorkspace(); disposeWorkspace = workspace.dispose; await workspace.initialize();
  const { ApiWorkbench } = await import("./api-workbench");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<ApiWorkbench projectId={projectId} />));
  return { container, requests, workspace, created, revoked, publishCheck() {
    if (!stream) throw new Error("The workbench must first subscribe to the run");
    project.latestCheck = check;
    stream.enqueue(new TextEncoder().encode(`id: 1\nevent: check.completed\ndata: ${JSON.stringify({ schemaVersion: 1, eventId: "1", runId, attempt: 0, type: "check.completed", createdAt: now, payload: {} })}\n\n`));
  } };
}

it("shows a concise version-bound check, opens its details and loads a private screenshot only on request", async () => {
  const view = await openWorkbench();
  const card = view.container.querySelector<HTMLElement>('[aria-label="版本检查结果"]');
  expect(card?.textContent).toContain("关键流程检查通过");
  expect(card?.textContent).toContain("报名提交符合已保存的行为目标。");
  const details = card?.querySelector<HTMLDetailsElement>("details");
  expect(details?.open).toBe(false);
  expect(view.requests.filter((request) => request.url.includes("/artifacts/"))).toHaveLength(0);
  await act(async () => details?.querySelector("summary")?.click());
  expect(details?.open).toBe(true);
  expect(details?.textContent).toContain("报名记录出现在列表中");
  expect(details?.textContent).toContain("提交后列表出现了张小雨");
  expect(details?.textContent).toContain("填写中文姓名");
  const screenshot = details?.querySelector<HTMLButtonElement>('button[aria-label="查看 B01 截图 1"]');
  expect(screenshot).toBeTruthy();
  await act(async () => screenshot?.click());
  await act(async () => { await vi.waitFor(() => expect(view.created).toHaveBeenCalled()); });
  expect(card?.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe("blob:review-fixture");
  const request = view.requests.find((item) => item.url.includes("/artifacts/"));
  expect(request?.authorization).toMatch(/^Bearer /);
  expect(request?.url).not.toContain("token");
  await act(async () => view.workspace.logout());
  expect(view.container.querySelector('[aria-label="版本检查结果"]')).toBeNull();
  expect(view.revoked).toHaveBeenCalledWith("blob:review-fixture");
});

it.each([
  ["failed", "关键流程检查未通过"], ["blocked", "关键流程检查受阻"],
] as const)("keeps a %s check distinct from an unchecked candidate in both result and conversation", async (verdict, heading) => {
  const view = await openWorkbench({ verdict });
  expect(view.container.querySelector('[aria-label="版本检查结果"]')?.textContent).toContain(heading);
  expect(view.container.querySelector('[data-testid="run-result"] strong')?.textContent).toBe(heading);
  expect(view.container.textContent).not.toContain("关键流程检查通过");
  expect(view.container.textContent).not.toContain("候选已保存 · 尚未检查");
});

it("does not label an unchecked candidate as a passed check", async () => {
  const view = await openWorkbench({ unchecked: true });
  expect(view.container.querySelector('[aria-label="版本检查结果"]')?.textContent).toContain("尚未检查");
  expect(view.container.textContent).not.toContain("关键流程检查通过");
  expect(view.container.querySelector('[aria-label="版本检查结果"] details')).toBeNull();
});

it("shows all five server-derived groups and their six actual child results without turning one failure into 5/5", async () => {
  const view = await openWorkbench({ verdict: "failed", grouped: true });
  const card = view.container.querySelector<HTMLElement>('[aria-label="版本检查结果"]')!;
  expect(card.textContent).toContain("4/5 组通过");
  expect(card.textContent).toContain("6 项完整子检查");
  for (const name of ["数值运算", "输入键盘", "错误恢复", "结果历史", "视觉布局"])
    expect(card.textContent).toContain(name);
  for (const id of ["B01", "B02", "B03", "B04", "B05", "B06"])
    expect(card.querySelector(`[aria-label="行为 ${id}"]`)).toBeTruthy();
  expect(card.querySelector('[aria-label="G3 错误恢复"]')?.textContent).toContain("未通过");
});

it("keeps an old flat Check labeled with its original count rather than inferring five groups", async () => {
  const legacy = await openWorkbench();
  expect(legacy.container.querySelector('[aria-label="版本检查结果"]')?.textContent).toContain("历史平铺");
  expect(legacy.container.querySelector('[aria-label="版本检查结果"]')?.textContent).toContain("1/1");
  expect(legacy.container.querySelector('[aria-label="版本检查结果"]')?.textContent).not.toContain("5/5");
});

it("labels a rejected candidate separately while the earlier accepted revision remains current", async () => {
  const view = await openWorkbench({ verdict: "failed", previousCurrent: true });
  const picker = view.container.querySelector<HTMLSelectElement>("[data-testid=history-version-select]");
  expect(Array.from(picker?.options ?? [], (option) => option.textContent)).toEqual(["v2 · 未通过", "v1 · 当前"]);
  expect(picker?.selectedOptions[0].textContent).toBe("v1 · 当前");
  await act(async () => { if (picker) { picker.value = revisionId; picker.dispatchEvent(new Event("change", { bubbles: true })); } });
  expect(view.container.querySelector('[aria-label="版本检查结果"]')?.textContent).toContain("关键流程检查未通过");
  const currentSummary = view.container.querySelector('[data-testid="current-version-summary"]');
  expect(currentSummary?.textContent).toContain("当前成功版本");
  expect(currentSummary?.querySelector("strong")?.textContent).toBe("v1");
});

it("explains that two failed repairs reached the limit while the accepted revision stays current", async () => {
  const view = await openWorkbench({ verdict: "failed", previousCurrent: true, attempt: 2 });
  const outcome = view.container.querySelector('[data-testid="run-result"]');
  expect(outcome?.textContent).toContain("已尝试修复 2 轮，已达上限，停止自动修复。");
  expect(outcome?.textContent).toContain("报名提交尚未达到预期。");
  expect(view.container.querySelector<HTMLSelectElement>("[data-testid=history-version-select]")?.selectedOptions[0].textContent).toBe("v1 · 当前");
});

it("rejects a check bound to a different source snapshot before showing its verdict or screenshots", async () => {
  const view = await openWorkbench({ mismatch: true });
  expect(view.container.querySelector('[aria-label="版本检查结果"] [role="alert"]')?.textContent).toContain("版本不一致");
  expect(view.container.textContent).not.toContain("关键流程检查通过");
  expect(view.container.textContent).not.toContain("报名提交符合已保存的行为目标");
  expect(view.requests.filter((request) => request.url.includes("/artifacts/"))).toHaveLength(0);
});

it("offers the final saved screenshot even when no behavior item references it", async () => {
  const view = await openWorkbench({ finalScreenshot: true });
  const details = view.container.querySelector<HTMLDetailsElement>('[aria-label="版本检查结果"] details');
  await act(async () => details?.querySelector("summary")?.click());
  expect(view.requests.filter((request) => request.url.includes("/artifacts/"))).toHaveLength(0);
  const screenshot = details?.querySelector<HTMLButtonElement>('button[aria-label="查看检查截图 1"]');
  expect(screenshot).toBeTruthy();
  await act(async () => screenshot?.click());
  await act(async () => { await vi.waitFor(() => expect(view.created).toHaveBeenCalledTimes(1)); });
  expect(details?.querySelectorAll("img")).toHaveLength(1);
  expect(view.requests.filter((request) => request.url.includes("/artifacts/"))).toHaveLength(1);
});

it("explains an unavailable private screenshot without rendering its protected endpoint", async () => {
  const view = await openWorkbench({ screenshotDenied: true });
  const details = view.container.querySelector<HTMLDetailsElement>('[aria-label="版本检查结果"] details');
  await act(async () => details?.querySelector("summary")?.click());
  await act(async () => details?.querySelector<HTMLButtonElement>('button[aria-label="查看 B01 截图 1"]')?.click());
  expect(details?.querySelector('[role="alert"]')?.textContent).toContain("无法读取这张检查截图");
  expect(details?.querySelector("img")).toBeNull();
  expect(view.created).not.toHaveBeenCalled();
  expect(view.container.innerHTML).not.toContain("/api/v1/checks/");
});

it("reads the authoritative saved check immediately after check.completed without another submission", async () => {
  const view = await openWorkbench({ reviewing: true });
  expect(view.container.querySelector('[aria-label="版本检查结果"]')?.textContent).toContain("正在检查关键流程");
  const reads = view.requests.filter((request) => request.url === `/api/v1/projects/${projectId}`).length;
  await act(async () => view.publishCheck());
  expect(view.requests.filter((request) => request.url === `/api/v1/projects/${projectId}`).length).toBeGreaterThan(reads);
  expect(view.container.querySelector('[aria-label="版本检查结果"]')?.textContent).toContain("关键流程检查通过");
});
