import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Preview, Revision } from "@pivloom/contracts";
import type { GenerationApi } from "@/lib/generation-api";
import { GenerationResult } from "./generation-result";

vi.mock("./generation-review", () => ({ GenerationReview: () => null }));
vi.mock("@/lib/ui-preferences", () => ({ useUiPreferences: () => ({ text: (zh: string) => zh }) }));

const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
const revisionId = "09d00eb6-661f-4ed7-9e96-a46f4e2c800e";
const url = `https://${revisionId}.preview.example.test/p/${revisionId}/`;
const hash = "a".repeat(64);
const revision = (status: Revision["status"]): Revision => ({
  id: revisionId, projectId, runId: "74b24d87-1342-4d43-8c4e-f82e766a0633",
  revisionNo: 1, attempt: 0, sourceHash: hash, templateVersion: "fixture-v1",
  buildStatus: "passed", status, createdAt: new Date().toISOString(), manifest: [],
});
const preview = (expiresAt: string): Preview => ({
  state: "ready", revisionId, sourceHash: hash, url, expiresAt, error: null,
});

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("renews the same revision's private cookie when a passed Check extends Preview from seven to thirty minutes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const opened = vi.fn<(project: string, revision: string) => Promise<{ url: string; revisionId: string; grant: string }>>(
    async () => ({ url, revisionId, grant: "a".repeat(64) }));
  const posted = vi.fn<(endpoint: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", posted);
  const generation = { openPreview: opened, getCheck: async () => null } as unknown as GenerationApi;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const firstExpiry = new Date(Date.now() + 7 * 60_000).toISOString();
  await act(async () => root?.render(<GenerationResult projectId={projectId} revision={revision("candidate")}
    preview={preview(firstExpiry)} generation={generation} active checking />));
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe(url);

  const acceptedExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
  await act(async () => root?.render(<GenerationResult projectId={projectId} revision={revision("accepted")}
    preview={preview(acceptedExpiry)} generation={generation} active={false} />));
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(opened).toHaveBeenCalledTimes(2);
  expect(opened.mock.calls.every(([project, savedRevision]) => project === projectId && savedRevision === revisionId)).toBe(true);
  expect(posted.mock.calls.every(([endpoint, init]) => String(endpoint) === `${url}session`
    && new Headers(init?.headers).get("Authorization") === `Preview ${"a".repeat(64)}`)).toBe(true);
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe(url);
  expect(container.querySelector("iframe")?.getAttribute("src")).not.toContain("grant");
});

it("batches short rolling lease updates and refreshes the Cookie before its original expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const opened = vi.fn<(project: string, revision: string) => Promise<{ url: string; revisionId: string; grant: string }>>(
    async () => ({ url, revisionId, grant: "b".repeat(64) }));
  const posted = vi.fn<(endpoint: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", posted);
  const generation = { openPreview: opened, getCheck: async () => null } as unknown as GenerationApi;
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<GenerationResult projectId={projectId} revision={revision("candidate")}
    preview={preview(new Date(Date.now() + 7 * 60_000).toISOString())} generation={generation} active checking />));
  expect(posted).toHaveBeenCalledTimes(1);
  await act(async () => root?.render(<GenerationResult projectId={projectId} revision={revision("candidate")}
    preview={preview(new Date(Date.now() + 9 * 60_000).toISOString())} generation={generation} active checking />));
  expect(posted).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(4 * 60_000));
  expect(posted).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(posted).toHaveBeenCalledTimes(2);
  expect(opened).toHaveBeenCalledTimes(2);
  expect(Date.now()).toBeLessThan(Date.parse("2026-09-24T00:07:00.000Z"));
});

it("never reuses another project or API session's grant for the same Preview URL", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const posted = vi.fn<(endpoint: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", posted);
  const first = { openPreview: vi.fn(async () => ({ url, revisionId, grant: "a".repeat(64) })), getCheck: async () => null } as unknown as GenerationApi;
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const expiresAt = new Date(Date.now() + 7 * 60_000).toISOString();
  await act(async () => root?.render(<GenerationResult projectId={projectId} revision={revision("candidate")}
    preview={preview(expiresAt)} generation={first} active checking />));
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe(url);

  const otherProject = "810a101e-e123-4dad-90a7-cbbfae291903";
  const second = { openPreview: vi.fn(async () => ({ url: "https://wrong.preview.example.test/", revisionId, grant: "c".repeat(64) })),
    getCheck: async () => null } as unknown as GenerationApi;
  await act(async () => root?.render(<GenerationResult projectId={otherProject} revision={revision("candidate")}
    preview={preview(expiresAt)} generation={second} active checking />));
  await vi.waitFor(() => expect(container.querySelector("[role=alert]")?.textContent).toContain("版本不一致"));
  expect(container.querySelector("iframe")).toBeNull();
  expect(posted).toHaveBeenCalledTimes(1);
});

it("shows a restore that is waiting for capacity as its own state instead of an unavailable preview", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const generation = { openPreview: vi.fn(), getCheck: async () => null } as unknown as GenerationApi;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queued: Preview = { state: "queued", revisionId, sourceHash: hash, url: null, expiresAt: null,
    error: "沙箱容量已满，已排队等待；资源可用后会自动开始重建预览，不会调用模型。" };
  await act(async () => root?.render(<GenerationResult projectId={projectId} revision={revision("accepted")}
    preview={queued} generation={generation} active={false} />));
  // Waiting for a slot is not a failure and offers no restart button: the
  // scheduler starts it, so the page must not ask the user to do anything.
  expect(container.textContent).toContain("已排队等待沙箱容量");
  expect(container.textContent).toContain("资源可用后会自动开始重建预览");
  expect(container.querySelector("iframe")).toBeNull();
  expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.includes("重新启动预览"))).toBe(false);
});
