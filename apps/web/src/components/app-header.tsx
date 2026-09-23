"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import { ArrowLeft, ChevronDown, Globe2, LayoutTemplate, LogOut, Moon, Sun, UserCircle } from "lucide-react";
import { useState } from "react";
import { Brand } from "./brand";
import { useWorkspaceAuth } from "@/lib/use-workspace";
import { isDemoMode } from "@/lib/workspace";
import { errorMessage } from "@/lib/utils";
import { useUiPreferences } from "@/lib/ui-preferences";

export function AppHeader({
  title,
  saving = false,
  children,
}: {
  title?: string;
  saving?: boolean;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const { user, auth } = useWorkspaceAuth();
  const ui = useUiPreferences();
  const [error, setError] = useState("");
  async function logout() {
    try {
      await auth.logout();
      router.replace("/login");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <header className="app-header">
      <div className="header-left">
        <Brand small={!!title} />
        {title && (
          <>
            <span className="header-divider" />
            <Link href="/projects" className="back-link">
              <ArrowLeft size={15} />
              <span>{ui.text("我的项目", "My projects")}</span>
            </Link>
            <span className="project-breadcrumb">/</span>
            <h1 className="project-title">{title}</h1>
          </>
        )}
      </div>
      <div className="header-right">
        {children}
        {title && (
          <span className="saved-state">
            <i className={saving ? "status-dot dot-pulse" : "status-dot"} />
            {saving ? ui.text("生成中", "Generating") : isDemoMode ? ui.text("本地已保存", "Saved locally") : ui.text("已保存", "Saved")}
          </span>
        )}
        <Link className="settings-header-link" href="/templates"><LayoutTemplate size={14} />{ui.text("模板", "Templates")}</Link>
        {!isDemoMode && <Link className="settings-header-link" href="/settings/models">{ui.text("模型设置", "Models")}</Link>}
        <button type="button" className="header-control" onClick={() => ui.setLocale(ui.locale === "zh" ? "en" : "zh")} aria-label={ui.locale === "zh" ? "切换到英文" : "Switch to Chinese"}><Globe2 size={15} /><span>{ui.locale === "zh" ? "EN" : "中文"}</span></button>
        <button type="button" className="header-control theme-control" onClick={() => ui.setTheme(ui.theme === "light" ? "dark" : "light")} aria-label={ui.theme === "light" ? ui.text("切换深色模式", "Switch to dark mode") : ui.text("切换浅色模式", "Switch to light mode")}>{ui.theme === "light" ? <Moon size={16} /> : <Sun size={16} />}</button>
        {isDemoMode && <span
          className="demo-badge"
          title="所有接口与生成过程使用模拟数据，不会调用模型"
        >
          演示模式
        </span>}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="account-trigger" aria-label={ui.text("账号菜单", "Account menu")}>
              <span className="avatar">{(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}</span>
              <ChevronDown size={12} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="dropdown-content"
              sideOffset={10}
              align="end"
            >
              <div className="account-description">
                <strong>{ui.locale === "zh" ? `${user?.name || "我的"} 的工作空间` : `${user?.name || "My"}'s workspace`}</strong>
                <span>{user?.email}</span>
              </div>
              <DropdownMenu.Separator className="menu-separator" />
              {!isDemoMode && <DropdownMenu.Item className="dropdown-item" asChild><Link href="/settings/account"><UserCircle size={15} />{ui.text("账户与额度", "Account & usage")}</Link></DropdownMenu.Item>}
              <DropdownMenu.Item className="dropdown-item" asChild><Link href="/templates"><LayoutTemplate size={15} />{ui.text("浏览模板", "Browse templates")}</Link></DropdownMenu.Item>
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() => void logout()}
              >
                <LogOut size={15} />
                {ui.text("退出登录", "Sign out")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {error && (
          <span className="header-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </header>
  );
}
