import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectDetailResponse, Revision, Run } from "@pivloom/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
let root: Root | undefined;
let dispose: (() => void) | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; dispose?.(); document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  document.head.querySelector('style[data-candidate-test]')?.remove();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
});

it("explicitly continues a saved candidate after reopening while preserving the accepted and published versions", async () => {
  const styles = document.createElement('style');
  styles.dataset.candidateTest = 'true';
  styles.textContent = readFileSync(resolve(process.cwd(), 'src/app/a-interface.css'), 'utf8');
  document.head.append(styles);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "api");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://identity.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
  const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
  const profileId = "438088cb-5fd0-4704-ad57-3b64ed47c55f";
  const runId = "74b24d87-1342-4d43-8c4e-f82e766a0633";
  const acceptedId = "753f8374-d88f-4399-b366-0aa544d03a2f";
  const candidateId = "530f8374-d88f-4399-b366-0aa544d03a2f";
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: ownerId, email: "owner@example.test", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: now };
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  localStorage.setItem("pivloom.auth.v1", JSON.stringify({ access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiresAt })}.fixture`, refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user }));
  const accepted: Revision = { id: acceptedId, projectId, runId, revisionNo: 1, attempt: 0, sourceHash: "a".repeat(64), templateVersion: "fixture", buildStatus: "passed", status: "accepted", createdAt: now, manifest: [] };
  const candidate: Revision = { ...accepted, id: candidateId, revisionNo: 2, sourceHash: "b".repeat(64), status: "candidate" };
  const run: Run = { id: runId, projectId, state: "failed", phase: "review", attempt: 0, requestText: "保存待检查修改", modelProfileId: profileId, modelConfigVersion: 1, modelId: null, baseRevisionId: acceptedId, resultRevisionId: candidateId, createdAt: now, deadlineAt: now, finishedAt: now, cleanupState: "confirmed", error: { code: "CHECK_BLOCKED", message: "浏览器检查受阻", retryable: true }, summary: null };
  const project: ProjectDetailResponse = { project: { id: projectId, title: "候选恢复", createdAt: now, updatedAt: now, currentRevisionId: acceptedId, activeRunState: null, activeRunPosition: null }, messages: [], currentRevision: accepted, latestCandidate: candidate, activeRun: null, latestRun: run, latestCheck: null, preview: null };
  const submissions: Record<string, unknown>[] = [];
  const mutations: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") mutations.push(url);
    if (url === "https://identity.example.test/auth/v1/user") return Response.json(user);
    if (url === "/api/v1/me") return Response.json({ user: { id: ownerId, name: "Owner", email: user.email } });
    if (url === "/api/v1/tasks") return Response.json({ tasks: [] });
    if (url === "/api/v1/model-profiles") return Response.json({ profiles: [{ id: profileId, name: "测试模型", provider: "openai-completions", baseUrl: "https://provider.example.test/v1", modelId: "fixture", configVersion: 1, keyMask: "masked", isDefault: true, capabilities: { streaming: "verified", tools: "verified", vision: "verified" }, lastTest: null, createdAt: now, updatedAt: now }] });
    if (url === `/api/v1/model-profiles/${profileId}/models`) return Response.json({ source: "none", models: [] });
    if (url === `/api/v1/projects/${projectId}`) return Response.json(project);
    if (url === `/api/v1/projects/${projectId}/revisions`) return Response.json({ projectId, currentRevisionId: acceptedId, revisions: [candidate, accepted] });
    if (url === `/api/v1/projects/${projectId}/publication`) return Response.json({ publication: { projectId, revisionId: acceptedId, sourceHash: accepted.sourceHash, url: "https://published.example.test", publishedAt: now } });
    if (url.includes("/preview?")) return Response.json({ preview: { state: "unavailable", revisionId: new URL(url, "https://app.example.test").searchParams.get("revisionId"), sourceHash: url.includes(candidateId) ? candidate.sourceHash : accepted.sourceHash, url: null, expiresAt: null, error: null } });
    if (url.endsWith("/check")) return Response.json({ check: null });
    if (url === `/api/v1/runs/${runId}`) return Response.json({ run, revision: candidate, events: [], preview: null });
    if (url === `/api/v1/projects/${projectId}/runs`) {
      submissions.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { code: "QUOTA_EXCEEDED", message: "fixture admission boundary" } }, { status: 429 });
    }
    throw Error(`Unexpected fixture endpoint: ${url}`);
  });
  const { getApiWorkspace } = await import("@/lib/workspace");
  const workspace = getApiWorkspace(); dispose = workspace.dispose; await workspace.initialize();
  const { ApiWorkbench } = await import("./api-workbench");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<ApiWorkbench projectId={projectId} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="查看候选 v2"]')?.click());
  const continueButton = container.querySelector<HTMLButtonElement>('button[aria-label="从候选 v2 继续开发"]');
  expect(continueButton).not.toBeNull();
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "重新启动预览")).toBe(true);
  await act(async () => continueButton!.click());
  expect(container.textContent).toContain("继续基线：候选 v2");
  let selection = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(element => element.textContent?.includes('继续基线：候选 v2'))!;
  expect(getComputedStyle(selection).display).not.toBe('none');
  expect(container.textContent).toContain("未验收");
  expect(mutations).toEqual([]);
  await act(async () => root?.render(null));
  await act(async () => root?.render(<ApiWorkbench projectId={projectId} />));
  expect(container.textContent).toContain("继续基线：候选 v2");
  selection = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(element => element.textContent?.includes('继续基线：候选 v2'))!;
  expect(getComputedStyle(selection).display).not.toBe('none');
  expect(container.querySelector('button[aria-label="从候选 v2 继续开发"]')?.getAttribute('aria-pressed')).toBe('true');
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "在候选上增加搜索");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="发送需求"]')!.click());
  expect(submissions).toEqual([expect.objectContaining({ text: "在候选上增加搜索", selectedBaseRevisionId: candidateId, expectedCurrentRevisionId: acceptedId })]);
  expect(mutations).toEqual([`/api/v1/projects/${projectId}/runs`]);
  expect(project.project.currentRevisionId).toBe(acceptedId);
  await act(async () => selection.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.textContent).not.toContain('继续基线：候选 v2');
  expect(container.querySelector('button[aria-label="版本历史，正在查看 v1"]')).not.toBeNull();
  expect(project.project.currentRevisionId).toBe(acceptedId);
});
