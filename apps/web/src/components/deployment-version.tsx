"use client";

import { useEffect, useState } from "react";
import { Copy } from "lucide-react";

type Component = "web" | "api";
type Commits = Record<Component, string | null>;

async function readVersion(url: string, component: Component, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("component" in value) || value.component !== component
    || !("commit" in value) || typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit)) return null;
  return value.commit;
}

/** Shows the SHA embedded in each running artifact, rather than a checkout HEAD. */
export function DeploymentVersion() {
  const [commits, setCommits] = useState<Commits>({ web: null, api: null });
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      readVersion("/version", "web", controller.signal),
      readVersion("/api/v1/version", "api", controller.signal),
    ]).then(([web, api]) => {
      if (controller.signal.aborted) return;
      setCommits({ web: web.status === "fulfilled" ? web.value : null, api: api.status === "fulfilled" ? api.value : null });
    });
    return () => controller.abort();
  }, []);
  async function copy(component: Component) {
    const commit = commits[component];
    if (!commit) return;
    try { await navigator.clipboard.writeText(commit); setNotice(`${component.toUpperCase()} SHA 已复制`); }
    catch { setNotice("无法使用剪贴板，请从版本接口复制完整 SHA。"); }
  }
  return <aside className="deployment-version" aria-label="部署版本">
    <span className="deployment-version-title">部署版本</span>
    {(["web", "api"] as const).map((component) => <button key={component} type="button"
      aria-label={`复制 ${component === "web" ? "Web" : "API"} 完整 SHA`}
      title={commits[component] ?? "尚未核实构建版本"}
      disabled={!commits[component]} onClick={() => void copy(component)}>
      <span>{component === "web" ? "Web" : "API"} {commits[component]?.slice(0, 8) ?? "未核实"}</span>
      {commits[component] && <Copy size={12} aria-hidden="true" />}
    </button>)}
    {notice && <span role="status" className="deployment-version-notice">{notice}</span>}
  </aside>;
}
