"use client";

import { useState } from "react";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, Cpu, RefreshCw, Search, Settings2 } from "lucide-react";
import type { ModelProfile } from "@pivloom/contracts";
import { useUiPreferences } from "@/lib/ui-preferences";

export function SessionModelPicker({ profiles, selectedProfileId, catalog, effectiveModelId, lockedLabel, disabled, onProfile, onModel, onCustom, onRefresh }: {
  profiles: ModelProfile[] | undefined;
  selectedProfileId: string | undefined;
  catalog: { id: string; name: string }[];
  effectiveModelId: string | null;
  lockedLabel?: string;
  disabled: boolean;
  onProfile(id: string): void;
  onModel(id: string): void;
  onCustom(id: string): void;
  onRefresh(): void;
}) {
  const ui = useUiPreferences();
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");
  const profile = profiles?.find((item) => item.id === selectedProfileId);
  const modelName = catalog.find((item) => item.id === effectiveModelId)?.name ?? effectiveModelId ?? profile?.modelId;
  // A verified image probe belongs to one exact model ID, not to every model on
  // the same endpoint. An untested session override remains unknown.
  const vision = effectiveModelId && effectiveModelId !== profile?.modelId ? "unknown" : profile?.capabilities.vision ?? "unknown";
  const visionLabel = {
    unknown: ui.text("图像待验证", "Vision unknown"),
    verified: ui.text("图像已验证", "Vision verified"),
    unsupported: ui.text("不支持图像", "Vision unsupported"),
    failed: ui.text("图像测试失败", "Vision probe failed"),
  }[vision];
  const filtered = catalog.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  return <><DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><button type="button" className="session-model-trigger" disabled={disabled || !profiles?.length} aria-label={ui.text("选择会话模型", "Select session model")}><Cpu size={15} /><span>{lockedLabel ?? modelName ?? ui.text("选择模型", "Select model")}</span><ChevronDown size={13} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="session-model-menu" side="top" align="start" sideOffset={10}>
      <div className="session-model-menu-title"><strong>{ui.text("会话模型", "Session model")}</strong><span>{ui.text("下次任务生效", "For the next run")}</span></div>
      <div className="session-model-search"><Search size={14} /><input aria-label={ui.text("搜索模型", "Search models")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.stopPropagation()} placeholder={ui.text("搜索模型", "Search models")} /></div>
      <div className="session-model-menu-scroll">
        <div className="session-model-group-title">{ui.text("已连接配置", "Connected providers")}</div>
        {profiles?.filter((item) => `${item.name} ${item.modelId}`.toLowerCase().includes(query.toLowerCase()) || item.id === selectedProfileId).map((item) => <DropdownMenu.Item key={item.id} className="session-model-row" onSelect={() => onProfile(item.id)}><span className="session-model-provider-icon"><Cpu size={14} /></span><span><strong>{item.name}</strong><small>{item.modelId}{item.isDefault ? ui.text(" · 默认", " · Default") : ""}</small></span>{item.id === selectedProfileId && <Check size={15} />}</DropdownMenu.Item>)}
        {!!profile && !!filtered.length && <><div className="session-model-group-title">{ui.text(`${profile.name} 的模型`, `Models from ${profile.name}`)}</div>{filtered.map((item) => <DropdownMenu.Item key={item.id} className="session-model-row" onSelect={() => onModel(item.id)}><span className="session-model-provider-icon"><Cpu size={14} /></span><span><strong>{item.name}</strong><small>{item.id}</small></span>{item.id === effectiveModelId && <Check size={15} />}</DropdownMenu.Item>)}</>}
        {!!profile && <div className="session-model-custom"><label htmlFor="session-custom-model">{ui.text("其他模型 ID", "Other model ID")}</label><div><input id="session-custom-model" value={custom} onChange={(event) => setCustom(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter" && custom.trim()) { event.preventDefault(); onCustom(custom.trim()); setCustom(""); } }} placeholder="model-id" maxLength={160} /><button type="button" disabled={!custom.trim()} onClick={() => { onCustom(custom.trim()); setCustom(""); }}>{ui.text("使用", "Use")}</button></div></div>}
      </div>
      <div className="session-model-menu-footer"><button type="button" onClick={onRefresh}><RefreshCw size={13} />{ui.text("刷新", "Refresh")}</button><Link href="/settings/models"><Settings2 size={13} />{ui.text("管理模型", "Manage models")}</Link></div>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root><span className="session-model-vision-status" role="status">{visionLabel}</span></>;
}
