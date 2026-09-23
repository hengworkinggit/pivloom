"use client";

import { useCallback, useEffect, useState } from "react";
import { Code2, Copy, ExternalLink, FileCode2, FileJson2, LoaderCircle, Monitor, RotateCcw, Smartphone } from "lucide-react";
import type { Check, Preview, Revision } from "@pivloom/contracts";
import type { GenerationApi } from "@/lib/generation-api";
import { usePrivateQuery } from "@/lib/use-workspace";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { GenerationReview } from "./generation-review";
import { useUiPreferences } from "@/lib/ui-preferences";

function SourceViewer({ revision, generation }: { revision: Revision; generation: GenerationApi }) {
  const ui = useUiPreferences();
  const manifestLoader = useCallback(async () => {
    const manifest = await generation.getFiles(revision.id);
    if (manifest.revisionId !== revision.id || manifest.sourceHash !== revision.sourceHash) throw new Error("源码版本不一致，请重新打开项目。");
    return manifest;
  }, [generation, revision.id, revision.sourceHash]);
  const manifest = usePrivateQuery(manifestLoader);
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const file = manifest.data?.files.find((item) => item.path === selected) ?? manifest.data?.files[0];
  const fileLoader = useCallback(async () => {
    if (!file) return null;
    const source = await generation.getFile(revision.id, file.path);
    if (source.revisionId !== revision.id || source.path !== file.path || source.sha256 !== file.sha256) throw new Error("文件与所选快照不一致，请重新加载。");
    return source;
  }, [file, generation, revision.id]);
  const source = usePrivateQuery(fileLoader);
  if (manifest.error) return <div className="preview-empty" role="alert"><p>{manifest.error}</p><Button onClick={manifest.refresh} variant="outline">{ui.text("重新加载源码", "Reload source")}</Button></div>;
  if (!manifest.data) return <div className="preview-empty" role="status"><LoaderCircle className="spin" size={22} /><p>{ui.text("正在读取已保存的源码…", "Loading saved source…")}</p></div>;
  return <div className="source-viewer" data-testid="source-viewer">
    <aside className="source-tree" aria-label={ui.text("项目文件", "Project files")}><div className="source-tree-title">{ui.text("文件", "Files")} <span>{manifest.data.files.length}</span></div>
      {manifest.data.files.map((item) => <button key={item.path} className={cn("source-file", item.path === file?.path && "selected")} aria-pressed={item.path === file?.path} onClick={() => setSelected(item.path)}>
        {item.path.endsWith(".json") ? <FileJson2 size={14} /> : <FileCode2 size={14} />}<span>{item.path}</span>
      </button>)}
    </aside>
    <section className="source-editor">
      <div className="source-file-bar"><span><FileCode2 size={14} />{file?.path ?? ui.text("没有源文件", "No source file")}</span><div><span className="readonly-badge">v{revision.revisionNo} · {ui.text("只读", "Read only")}</span>
        <Button variant="ghost" size="icon" aria-label={ui.text("复制当前文件", "Copy current file")} disabled={!source.data} onClick={async () => {
          if (!source.data) return;
          try { await navigator.clipboard.writeText(source.data.content); setNotice(ui.text("代码已复制", "Code copied")); }
          catch { setNotice(ui.text("无法使用剪贴板，请选择源码后复制。", "Clipboard unavailable. Select and copy the source instead.")); }
        }}><Copy size={14} /></Button></div>
      </div>
      {source.error ? <div className="preview-empty" role="alert"><p>{source.error}</p><Button onClick={source.refresh} variant="outline">{ui.text("重新加载文件", "Reload file")}</Button></div>
        : source.data ? <pre className="code-content" tabIndex={0} aria-label={source.data.path}>{source.data.content.split("\n").map((line, index) => <div className="code-line" key={index}><span aria-hidden="true" className="line-number">{index + 1}</span><code>{line || " "}</code></div>)}</pre>
          : <div className="preview-empty" role="status">{ui.text("正在读取文件…", "Loading file…")}</div>}
      {notice && <p className="generation-copy-notice" role="status">{notice}</p>}
    </section>
  </div>;
}

function previewUrl(preview: Preview | null, revision: Revision | null, origin: string) {
  if (!preview || !revision || preview.state !== "ready" || !preview.url
    || preview.revisionId !== revision.id || preview.sourceHash !== revision.sourceHash) return null;
  try {
    const url = new URL(preview.url);
    if (!["http:", "https:"].includes(url.protocol) || url.origin === origin || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function GenerationResult({ revision, preview, generation, active, latestCheck, checking = false, restoring = false, onRestore }: {
  revision: Revision | null; preview: Preview | null; generation: GenerationApi; active: boolean; latestCheck?: Check | null; checking?: boolean;
  restoring?: boolean; onRestore?: () => void;
}) {
  const ui = useUiPreferences();
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState(() => Date.now());
  useEffect(() => {
    if (!preview?.expiresAt) return;
    const delay = new Date(preview.expiresAt).getTime() - Date.now();
    const timer = setTimeout(() => setObservedAt(Date.now()), Math.max(0, Math.min(delay + 10, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [preview?.expiresAt]);
  const expired = preview?.state === "expired" || !!preview?.expiresAt && Date.parse(preview.expiresAt) <= observedAt;
  const url = expired ? null : previewUrl(preview, revision, typeof window === "undefined" ? "" : window.location.origin);
  const frameKey = `${url ?? "empty"}:${reloadKey}`;
  const candidate = revision?.status === "candidate";
  return <section className="result-panel" aria-label={ui.text("应用结果", "App result")}>
    <div className="result-toolbar"><div className="result-toolbar-left"><div className="view-tabs" role="tablist" aria-label={ui.text("结果视图", "Result views")}>
      {(["preview", "code"] as const).map((value) => <button key={value} role="tab" id={`${value}-tab`} aria-selected={tab === value} aria-controls={`${value}-panel`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); const next = value === "preview" ? "code" : "preview"; setTab(next); document.getElementById(`${next}-tab`)?.focus();
      }}>{value === "preview" ? <Monitor size={14} /> : <Code2 size={15} />}{value === "preview" ? ui.text("预览", "Preview") : ui.text("代码", "Code")}</button>)}
    </div>{revision && <span className="version-badge">v{revision.revisionNo}{candidate ? ui.text(" 候选", " Candidate") : ""}</span>}</div>
      {tab === "preview" && <div className="preview-actions"><div className="device-toggle" aria-label={ui.text("预览宽度", "Preview width")}>
        <button aria-label={ui.text("桌面预览", "Desktop preview")} aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}><Monitor size={14} /></button>
        <button aria-label={ui.text("窄屏预览", "Narrow preview")} aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")}><Smartphone size={13} /></button>
      </div><button className="icon-button" aria-label={ui.text("刷新预览", "Refresh preview")} disabled={!url} onClick={() => setReloadKey((value) => value + 1)}><RotateCcw size={14} /></button>
        {url && <a className="icon-button" href={url} target="_blank" rel="noopener noreferrer" aria-label={ui.text("在新标签页打开预览", "Open preview in a new tab")}><ExternalLink size={15} /></a>}
      </div>}
    </div>
    {revision && <><div className="previous-version-note">{candidate ? ui.text("候选已保存", "Candidate saved") : ui.text("已保存版本", "Saved version")}{active ? ui.text(" · 新任务正在执行，当前显示此版本", " · New run in progress; showing this version") : ""}</div>
      <GenerationReview key={`${revision.id}:${checking}`} revision={revision} latestCheck={latestCheck} generation={generation} checking={checking} /></>}
    <div id="code-panel" role="tabpanel" aria-labelledby="code-tab" className="code-panel" hidden={tab !== "code"}>
      {tab === "code" && (revision ? <SourceViewer key={revision.id} revision={revision} generation={generation} /> : <div className="preview-empty"><Code2 size={28} /><h2>{ui.text("还没有生成源码", "No source yet")}</h2><p>{ui.text("候选保存后，可以查看对应的多文件快照。", "Saved candidates will show their source files here.")}</p></div>)}
    </div>
    <div id="preview-panel" role="tabpanel" aria-labelledby="preview-tab" className={cn("preview-canvas", device === "mobile" && "preview-canvas-mobile")} hidden={tab !== "preview"}>
      {restoring && <div className="preview-empty" role="status" data-testid="preview-restoring"><LoaderCircle className="spin" size={22} />
        <h2>{ui.text("正在重建预览", "Restoring preview")}</h2><p>{ui.text("从已保存的源码重新启动预览，不会调用模型，也不会改变版本或检查结论。", "Starting from saved source without calling a model or changing the version.")}</p></div>}
      {url ? <div className={cn("preview-frame", device === "mobile" && "phone-frame")}>
        {loaded !== frameKey && <div className="generation-preview-loading" role="status"><LoaderCircle className="spin" size={16} />{ui.text("正在加载预览…", "Loading preview…")}</div>}
        <iframe key={frameKey} src={url} title={ui.text("应用预览", "App preview")} className="app-preview-iframe" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" onLoad={() => setLoaded(frameKey)} />
      </div> : <div className="preview-empty"><div className="empty-preview-icon"><Monitor size={27} /></div>
        <h2>{expired ? ui.text("预览已到期", "Preview expired") : revision ? ui.text("预览暂不可用", "Preview unavailable") : active ? ui.text("正在构建你的应用", "Building your app") : ui.text("你的应用，将从这里开始", "Your app starts here")}</h2>
        <p>{expired ? ui.text("源码快照已保存，可以在代码页查看；重新启动预览不会调用模型。", "Source is saved in Code. Restarting the preview will not call a model.") : revision ? preview?.error ?? ui.text("候选源码已保存，尚未获得可访问的预览。", "Candidate source is saved; the preview is not available yet.") : active ? ui.text("实际构建与快照保存完成后，候选预览会出现在这里。", "The preview appears here after build and snapshot complete.") : ui.text("在左侧描述需求，开始第一次真实构建。", "Describe your request on the left to start building.")}</p>
        {expired && revision && revision.buildStatus === "passed" && onRestore &&
          <Button onClick={onRestore} disabled={restoring}>{restoring ? <><LoaderCircle className="spin" size={14} />{ui.text("正在重建…", "Restoring…")}</> : ui.text("重新启动预览", "Restart preview")}</Button>}
      </div>}
    </div>
    <footer className="result-footer"><span>{revision ? `${ui.text("版本", "Version")} ${revision.revisionNo} · ${revision.id.slice(0, 8)}` : ui.text("尚无版本", "No version yet")}</span><span>{device === "mobile" ? ui.text("窄屏布局 · 非移动设备模拟", "Narrow layout · not a device emulator") : ui.text("独立应用预览", "Isolated app preview")}</span></footer>
  </section>;
}
