"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import { ArrowLeft, ChevronDown, LogOut } from "lucide-react";
import { useState } from "react";
import { Brand } from "./brand";
import { demoApi } from "@/lib/mock-api";
import { errorMessage } from "@/lib/utils";

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
  const [error, setError] = useState("");
  async function logout() {
    try {
      await demoApi.logout();
      router.push("/login");
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
              <span>我的项目</span>
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
            {saving ? "生成中" : "本地已保存"}
          </span>
        )}
        <span
          className="demo-badge"
          title="所有接口与生成过程使用模拟数据，不会调用模型"
        >
          演示模式
        </span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="account-trigger" aria-label="账号菜单">
              <span className="avatar">H</span>
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
                <strong>Heng 的工作空间</strong>
                <span>demo@pivloom.app</span>
              </div>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() => void logout()}
              >
                <LogOut size={15} />
                退出登录
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
