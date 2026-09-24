"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Globe2, LoaderCircle, Moon, Sun } from "lucide-react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { configurationProblem, isDemoMode, registerAccount } from "@/lib/workspace";
import { useWorkspaceAuth } from "@/lib/use-workspace";
import { useUiPreferences } from "@/lib/ui-preferences";
import { errorMessage } from "@/lib/utils";

export function RegisterPage() {
  const router = useRouter();
  const { status } = useWorkspaceAuth();
  const ui = useUiPreferences();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const submitting = useRef(false);
  const problem = configurationProblem();
  function destination() {
    const next = new URLSearchParams(window.location.search).get("next");
    return next?.startsWith("/") && !next.startsWith("//") ? next : "/projects";
  }
  useEffect(() => { if (status === "authenticated") router.replace(destination()); }, [status, router]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || problem || isDemoMode) return;
    if (password.length < 8) { setError(ui.text("密码至少需要 8 位。", "Use at least 8 characters for your password.")); return; }
    if (password !== confirm) { setError(ui.text("两次输入的密码不一致。", "The passwords do not match.")); return; }
    submitting.current = true; setBusy(true); setError("");
    const target = destination();
    try {
      const result = await registerAccount({ name, email, password });
      setPassword(""); setConfirm("");
      if (result.requiresConfirmation) setPendingEmail(email.trim());
      else router.replace(target);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <main className="login-page a-auth-page">
    <div className="login-preferences"><button type="button" className="header-control" aria-label={ui.locale === "zh" ? "切换到英文" : "Switch to Chinese"} onClick={() => ui.setLocale(ui.locale === "zh" ? "en" : "zh")}><Globe2 size={15} />{ui.locale === "zh" ? "EN" : "中文"}</button><button type="button" className="header-control" aria-label={ui.theme === "light" ? ui.text("切换深色模式", "Switch to dark mode") : ui.text("切换浅色模式", "Switch to light mode")} onClick={() => ui.setTheme(ui.theme === "light" ? "dark" : "light")}>{ui.theme === "light" ? <Moon size={16} /> : <Sun size={16} />}</button></div>
    <Brand />
    <div className="login-card register-card">
      <div className="hero-eyebrow">CREATE YOUR SPACE</div>
      <h1>{ui.text("开始编织你的想法", "Start building your idea")}</h1>
      <p>{ui.text("创建账户，把作品留在自己的工作空间。", "Create an account and keep your work in your own space.")}</p>
      {pendingEmail ? <div className="auth-success" role="status"><strong>{ui.text("检查你的邮箱", "Check your inbox")}</strong><p>{ui.text(`如果 ${pendingEmail} 收到确认邮件，请先点击邮件里的链接，再回来登录。`, `If a confirmation email arrives at ${pendingEmail}, open its link before signing in.`)}</p><Link href="/login">{ui.text("前往登录", "Go to sign in")} <ArrowRight size={15} /></Link></div>
        : <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="register-name">{ui.text("称呼", "Name")}</label>
          <input id="register-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoComplete="name" required disabled={busy || !!problem || isDemoMode} />
          <label htmlFor="register-email">{ui.text("邮箱", "Email")}</label>
          <input id="register-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required disabled={busy || !!problem || isDemoMode} />
          <label htmlFor="register-password">{ui.text("密码", "Password")}</label>
          <div className="password-field"><input id="register-password" type={visible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required disabled={busy || !!problem || isDemoMode} /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? ui.text("隐藏密码", "Hide password") : ui.text("显示密码", "Show password")}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          <label htmlFor="register-confirm">{ui.text("确认密码", "Confirm password")}</label>
          <input id="register-confirm" type={visible ? "text" : "password"} value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" minLength={8} required disabled={busy || !!problem || isDemoMode} />
          {(problem || error || isDemoMode) && <p className="inline-error" role="alert">{problem || error || (isDemoMode ? ui.text("演示模式无需注册，请返回演示登录。", "Demo mode does not need registration.") : "")}</p>}
          <Button type="submit" disabled={busy || !!problem || isDemoMode}>{busy && <LoaderCircle className="spin" size={17} />}{busy ? ui.text("正在创建", "Creating account") : ui.text("创建账户", "Create account")}<ArrowRight size={17} /></Button>
        </form>}
      <div className="auth-switch">{ui.text("已有账户？", "Already have an account?")} <Link href="/login">{ui.text("登录", "Sign in")}</Link></div>
    </div>
    <p className="login-footer">{ui.text("把想法，织成应用。", "Weave your ideas into apps.")}</p>
  </main>;
}
