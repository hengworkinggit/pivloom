import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeploymentVersion } from "./deployment-version";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("the workbench shows separate artifact SHAs and copies each full value", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const webCommit = "a".repeat(40), apiCommit = "b".repeat(40);
  const requests: Array<{ url: string; cache?: RequestCache }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, cache: init?.cache });
    return Response.json(url === "/version"
      ? { component: "web", commit: webCommit, builtAt: "2026-09-23T13:00:00Z", buildId: webCommit, deploymentId: null }
      : { component: "api", commit: apiCommit, builtAt: "2026-09-23T13:00:00Z" });
  });
  const copied: string[] = [];
  const writeText = vi.fn(async (value: string) => { copied.push(value); });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<DeploymentVersion />); });
    expect(container.textContent).toContain(`Web ${webCommit.slice(0, 8)}`);
    expect(container.textContent).toContain(`API ${apiCommit.slice(0, 8)}`);
    expect(requests).toEqual([{ url: "/version", cache: "no-store" }, { url: "/api/v1/version", cache: "no-store" }]);
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="复制 Web 完整 SHA"]')?.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="复制 API 完整 SHA"]')?.click(); });
    expect(copied).toEqual([webCommit, apiCommit]);
  } finally { await act(async () => root.unmount()); }
});
