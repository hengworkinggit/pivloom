"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CircleUserRound, KeyRound, LoaderCircle, Mail, Sparkles } from "lucide-react";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { Button } from "./ui/button";
import { getApiWorkspace, updateAccount } from "@/lib/workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { useUiPreferences } from "@/lib/ui-preferences";
import { errorMessage } from "@/lib/utils";

function AccountContent() {
  const ui = useUiPreferences();
  const { user } = useWorkspaceAuth();
  const api = getApiWorkspace();
  const loadQuota = useCallback(async () => {
    const list = await api.listProjects();
    return list.projects[0] ? (await api.getProject(list.projects[0].id)).quota ?? null : null;
  }, [api]);
  const quota = usePrivateQuery(loadQuota);
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"name" | "email" | "password" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const remaining = quota.data ? Math.max(0, quota.data.dailyLimit - quota.data.dailyAccepted) : null;
  async function save(part: "name" | "email" | "password") {
    setError(""); setNotice(""); setBusy(part);
    try {
      if (part === "password" && password.length < 8) throw new Error(ui.text("密码至少需要 8 位。", "Use at least 8 characters for your password."));
      await updateAccount({ [part]: part === "name" ? name : part === "email" ? email : password });
      if (part === "password") setPassword("");
      setNotice(part === "email" ? ui.text("如需验证新邮箱，请前往邮箱完成确认。", "If asked, confirm the change from your new inbox.") : ui.text("账户信息已保存。", "Account updated."));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }
  return <div className="account-page"><AppHeader /><main className="account-main">
    <Link className="settings-back" href="/projects"><ArrowLeft size={15} />{ui.text("返回项目", "Back to projects")}</Link>
    <div className="account-heading"><div className="section-eyebrow">YOUR ACCOUNT</div><h1>{ui.text("账户与额度", "Account & usage")}</h1><p>{ui.text("管理个人信息，查看今天还能创建多少次任务。", "Manage your profile and see your available runs.")}</p></div>
    <div className="account-layout">
      <section className="account-panel" aria-labelledby="account-profile-title">
        <div className="account-panel-heading"><CircleUserRound size={20} /><div><h2 id="account-profile-title">{ui.text("个人信息", "Profile")}</h2><p>{ui.text("这些信息只与你的账户关联。", "These details belong to your account.")}</p></div></div>
        <label htmlFor="account-name">{ui.text("称呼", "Name")}</label><div className="account-field"><input id="account-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoComplete="name" /><Button size="sm" disabled={!!busy || !name.trim() || name.trim() === user?.name} onClick={() => void save("name")}>{busy === "name" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{ui.text("保存", "Save")}</Button></div>
        <label htmlFor="account-email"><Mail size={14} />{ui.text("邮箱", "Email")}</label><div className="account-field"><input id="account-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /><Button size="sm" disabled={!!busy || !email.trim() || email.trim() === user?.email} onClick={() => void save("email")}>{ui.text("更新", "Update")}</Button></div>
        <label htmlFor="account-password"><KeyRound size={14} />{ui.text("新密码", "New password")}</label><div className="account-field"><input id="account-password" type="password" value={password} minLength={8} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder={ui.text("至少 8 位", "At least 8 characters")} /><Button size="sm" disabled={!!busy || password.length < 8} onClick={() => void save("password")}>{ui.text("修改", "Change")}</Button></div>
        {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="account-notice" role="status"><Check size={15} />{notice}</p>}
      </section>
      <section className="account-panel quota-panel" aria-labelledby="account-quota-title">
        <div className="account-panel-heading"><Sparkles size={20} /><div><h2 id="account-quota-title">{ui.text("今日额度", "Today's usage")}</h2><p>{ui.text("按账户计算，所有项目共用。", "Shared by all your projects.")}</p></div></div>
        {quota.error && <p className="inline-error" role="alert">{quota.error}</p>}
        {quota.data ? <><div className="quota-large"><strong>{remaining}</strong><span>/ {quota.data.dailyLimit}</span></div><p>{ui.text("今日剩余可创建任务", "Runs remaining today")}</p><div className="quota-track" role="progressbar" aria-label={ui.text("今日额度使用", "Daily usage")} aria-valuenow={quota.data.dailyAccepted} aria-valuemin={0} aria-valuemax={quota.data.dailyLimit}><span style={{ width: `${quota.data.dailyLimit ? quota.data.dailyAccepted / quota.data.dailyLimit * 100 : 0}%` }} /></div><div className="quota-details"><span>{ui.text("已使用", "Used")} {quota.data.dailyAccepted}</span><span>{ui.text("总额度", "Limit")} {quota.data.dailyLimit}</span></div></>
          : quota.error ? <Button variant="outline" size="sm" onClick={quota.refresh}>{ui.text("重新读取", "Try again")}</Button>
          : <div className="quota-empty"><strong>—</strong><p>{ui.text("创建首个项目后，这里会显示服务端提供的准确额度。", "Create your first project to see your exact server-reported balance.")}</p></div>}
        <Link className="quota-link" href="/projects">{ui.text("回到项目", "Go to projects")} →</Link>
      </section>
    </div>
  </main></div>;
}

export function AccountPage() { return <AuthGate><AccountContent /></AuthGate>; }
