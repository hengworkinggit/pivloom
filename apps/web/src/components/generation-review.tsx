"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, CheckCircle2, CircleDashed, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Check, ReviewArtifact, Revision } from "@pivloom/contracts";
import type { GenerationApi } from "@/lib/generation-api";
import { usePrivateQuery } from "@/lib/use-workspace";
import { errorMessage } from "@/lib/utils";

export function checkMatchesRevision(check: Check, revision: Revision) {
  return check.revisionId === revision.id && check.sourceHash === revision.sourceHash
    && check.runId === revision.runId && check.attempt === revision.attempt;
}

function ReviewScreenshot({ checkId, artifact, label, generation }: {
  checkId: string; artifact: ReviewArtifact; label: string; generation: GenerationApi;
}) {
  const [result, setResult] = useState<{ url?: string; error?: string }>();
  const [retry, setRetry] = useState(0);
  const { id, mimeType, sha256 } = artifact;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void generation.getArtifact(checkId, { id, mimeType, sha256 }, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setResult({ url: objectUrl });
    }).catch((reason) => {
      if (!controller.signal.aborted) setResult({ error: errorMessage(reason) });
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [checkId, id, mimeType, sha256, generation, retry]);
  if (result?.error) return <div className="generation-review-image-error" role="alert"><p>无法读取这张检查截图：{result.error}</p><button onClick={() => { setResult(undefined); setRetry((value) => value + 1); }}>重试读取截图</button></div>;
  if (!result?.url) return <p className="generation-review-image-loading" role="status"><LoaderCircle className="spin" size={14} />正在读取检查截图…</p>;
  // The source is a verified PNG Blob, never a bearer URL or arbitrary model URL.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="generation-review-image" src={result.url} alt={label} />;
}

const verdictLabels = { passed: "通过", failed: "未通过", blocked: "受阻" } as const;
const checkLabels = { passed: "关键流程检查通过", failed: "关键流程检查未通过", blocked: "关键流程检查受阻" } as const;

export function GenerationReview({ revision, latestCheck, generation, checking }: {
  revision: Revision; latestCheck?: Check | null; generation: GenerationApi; checking: boolean;
}) {
  const fromSnapshot = latestCheck && checkMatchesRevision(latestCheck, revision) ? latestCheck : null;
  const load = useCallback(async () => {
    const check = fromSnapshot ?? await generation.getCheck(revision.id);
    if (check && !checkMatchesRevision(check, revision)) throw new Error("检查记录与当前查看的版本不一致，请重新读取。");
    return check;
  }, [fromSnapshot, generation, revision]);
  const query = usePrivateQuery(load);
  const check = fromSnapshot ?? query.data;
  const [visibleScreenshots, setVisibleScreenshots] = useState<string[]>([]);
  const title = check ? checkLabels[check.verdict] : query.error ? "暂时无法读取检查结果"
    : checking ? "正在检查关键流程" : query.data === null ? "尚未检查" : "正在读取检查记录…";
  const Icon = check?.verdict === "passed" ? CheckCircle2 : check || query.error ? TriangleAlert : CircleDashed;
  return <section className={`generation-review review-${check?.verdict ?? "unchecked"}`} aria-label="版本检查结果">
    <div className="generation-review-heading"><Icon size={16} aria-hidden="true" /><strong role="status">{title}</strong><span>v{revision.revisionNo}</span></div>
    {query.error && !check ? <p className="generation-review-error" role="alert">{query.error}<button onClick={query.refresh}>重新读取检查</button></p>
      : check ? <><p className="generation-review-summary">{check.summary}</p>
        <details className="generation-review-details"><summary>查看 {check.items.length} 项检查与截图</summary>
          {check.items.map((item) => <article className="generation-review-item" key={item.behaviorId} aria-label={`行为 ${item.behaviorId}`}>
            <h3>{item.behaviorId}<span className={`review-verdict verdict-${item.verdict}`}>{verdictLabels[item.verdict]}</span></h3>
            <dl><dt>预期结果</dt><dd>{item.expected}</dd><dt>实际观察</dt><dd>{item.actual}</dd></dl>
            {item.reproSteps.length > 0 && <div className="generation-review-steps"><strong>操作步骤</strong><ol>{item.reproSteps.map((step, index) => <li key={index}>{step}</li>)}</ol></div>}
            {item.observationEventIds.length > 0 && <p className="generation-review-observations">已保存 {item.observationEventIds.length} 条浏览器观察</p>}
            {item.screenshotIds.length > 0 && <p className="generation-review-observations">关联截图：{item.screenshotIds.map((id) => {
              const index = check.artifacts.findIndex((artifact) => artifact.id === id);
              return index < 0 ? "记录暂不可用" : String(index + 1);
            }).join("、")}</p>}
          </article>)}
          {check.artifacts.length > 0 && <section className="generation-review-gallery" aria-label="检查截图"><h3>检查截图</h3>{check.artifacts.map((artifact, index) => {
              const related = check.items.filter((item) => item.screenshotIds.includes(artifact.id)).map((item) => item.behaviorId);
              const label = related.length ? `${related.join("、")} 截图 ${index + 1}` : `检查截图 ${index + 1}`;
              const imageKey = `${check.id}:${artifact.id}:${artifact.sha256}`;
              const shown = visibleScreenshots.includes(imageKey);
              return <div className="generation-review-screenshot" key={imageKey}>
                <button aria-label={`${shown ? "收起" : "查看"}${related.length ? " " : ""}${label}`} aria-expanded={shown} aria-controls={`review-image-${artifact.id}`} onClick={() => setVisibleScreenshots((values) => shown ? values.filter((value) => value !== imageKey) : [...values, imageKey])}><Camera size={13} />{shown ? "收起" : "查看"}截图 {index + 1}{related.length > 0 ? ` · ${related.join("、")}` : " · 最终记录"}</button>
                {shown && <div id={`review-image-${artifact.id}`}><ReviewScreenshot checkId={check.id} artifact={artifact} label={label} generation={generation} /></div>}
              </div>;
            })}</section>}
          <p className="generation-review-scope">对应 v{revision.revisionNo} 的已保存快照 · {new Date(check.createdAt).toLocaleString("zh-CN", { hour12: false })}</p>
        </details></> : <p className="generation-review-summary">{checking ? "检查者正在操作这个候选版本，结果保存后会更新。" : "候选源码已保存，暂没有此版本的检查结论。"}</p>}
  </section>;
}
