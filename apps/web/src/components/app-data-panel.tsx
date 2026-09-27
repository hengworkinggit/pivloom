"use client";

import { useCallback, useState } from "react";
import type { AppDataKind, AppRecord } from "@pivloom/contracts";
import type { createAppDataApi } from "@/lib/app-data-api";
import { usePrivateQuery } from "@/lib/use-workspace";
import { errorMessage } from "@/lib/utils";
import { Button } from "./ui/button";

type AppDataApi = ReturnType<typeof createAppDataApi>;

export function AppDataPanel({ api, projectId, kind }: { api: AppDataApi; projectId: string; kind: AppDataKind }) {
  const loader = useCallback(() => api.list(projectId), [api, projectId]);
  const { data, error: loadError, refresh } = usePrivateQuery(loader);
  const [extra, setExtra] = useState<AppRecord[]>([]);
  const [next, setNext] = useState<number | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const records = [...(data?.records ?? []), ...extra.filter((item) => !data?.records.some((first) => first.id === item.id))];
  const nextOffset = next === undefined ? data?.nextOffset : next;

  async function change(record: AppRecord, confirmed: boolean) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.setConfirmed(projectId, record.id, confirmed);
      setExtra([]); setNext(undefined); refresh(); setNotice("状态已保存。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function remove(record: AppRecord) {
    if (busy || !window.confirm("确定永久删除这条记录吗？")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.remove(projectId, record.id);
      setExtra([]); setNext(undefined); refresh(); setNotice("记录已删除。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function more() {
    if (nextOffset == null || busy) return;
    setBusy(true); setError("");
    try {
      const page = await api.list(projectId, nextOffset);
      setExtra((items) => [...items, ...page.records.filter((row) => !items.some((item) => item.id === row.id))]);
      setNext(page.nextOffset);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function exportData() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const blob = await api.export(projectId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `pivloom-${projectId}-data.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <div className="a-app-data-panel">
    <p className="a-drawer-context">这些是已发布应用的服务端记录。Preview 中的示例数据不会混入这里；发布新代码或回滚源码也不会清空记录。</p>
    <div className="inline-actions"><Button variant="outline" onClick={() => void exportData()} disabled={busy}>导出全部 JSON</Button><Button variant="outline" onClick={() => { setExtra([]); setNext(undefined); refresh(); }} disabled={busy}>刷新记录</Button></div>
    {loadError && <p className="inline-error" role="alert">{loadError}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!data && !loadError && <p role="status">正在读取应用数据…</p>}
    {data && records.length === 0 && <p>还没有线上提交记录。</p>}
    <div className="list">{records.map((record) => <article className="row" key={record.id}>
      <div><strong>{record.collection === "registrations" ? record.name : `${record.date} · ${record.time}`}</strong>
        <small>{record.collection === "registrations" ? `${record.email} · ${record.category}` : `${record.name} · ${record.contact}`}</small>
        <small>{new Date(record.createdAt).toLocaleString("zh-CN")}</small></div>
      <div className="row-actions"><span className="badge">{record.confirmed ? "已确认" : "待确认"}</span>
        <button className="mini" disabled={busy} onClick={() => void change(record, !record.confirmed)}>{record.confirmed ? "撤销确认" : "确认"}</button>
        <button className="mini danger" disabled={busy} onClick={() => void remove(record)}>删除</button></div>
    </article>)}</div>
    {nextOffset != null && <Button variant="outline" disabled={busy} onClick={() => void more()}>加载更多</Button>}
    {kind === "appointments" && <p className="muted">同一日期和时段只接受一条预约；冲突由数据库处理。</p>}
  </div>;
}
