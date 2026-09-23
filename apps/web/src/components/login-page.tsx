"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Globe2, LoaderCircle, Moon, Sun } from "lucide-react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { configurationProblem, isDemoMode } from "@/lib/workspace";
import { useWorkspaceAuth } from "@/lib/use-workspace";
import { errorMessage } from "@/lib/utils";
import { useUiPreferences } from "@/lib/ui-preferences";

const DemoLogin = dynamic(() => import("./demo-login-page").then((module) => module.LoginPage));

function ApiLoginPage() {
  const router = useRouter();
  const { auth, status, error: authError } = useWorkspaceAuth();
  const ui = useUiPreferences();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const problem = configurationProblem();
  function destination() {
    const next = new URLSearchParams(window.location.search).get("next");
    return next?.startsWith("/") && !next.startsWith("//") ? next : "/projects";
  }
  useEffect(() => { if (status === "authenticated") router.replace(destination()); }, [status, router]);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || problem) return;
    submitting.current = true;
    setError(""); setBusy(true);
    try {
      await auth.login(email, password);
      setPassword("");
      router.replace(destination());
    } catch (error) { setError(errorMessage(error)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return (
    <main className="login-page">
      <div className="login-preferences"><button type="button" className="header-control" aria-label={ui.locale === "zh" ? "切换到英文" : "Switch to Chinese"} onClick={() => ui.setLocale(ui.locale === "zh" ? "en" : "zh")}><Globe2 size={15} />{ui.locale === "zh" ? "EN" : "中文"}</button><button type="button" className="header-control" aria-label={ui.theme === "light" ? ui.text("切换深色模式", "Switch to dark mode") : ui.text("切换浅色模式", "Switch to light mode")} onClick={() => ui.setTheme(ui.theme === "light" ? "dark" : "light")}>{ui.theme === "light" ? <Moon size={16} /> : <Sun size={16} />}</button></div>
      <Brand />
      <div className="login-card">
        <div className="hero-eyebrow">WELCOME BACK</div>
        <h1>{ui.text("继续编织你的想法", "Welcome back to your ideas")}</h1>
        <p>{ui.text("登录 Pivloom，回到你的创作空间。", "Sign in to Pivloom and pick up where you left off.")}</p>
        <form onSubmit={(event) => void login(event)}>
          <label htmlFor="email">{ui.text("邮箱", "Email")}</label>
          <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required disabled={busy || !!problem} />
          <label htmlFor="password">{ui.text("密码", "Password")}</label>
          <div className="password-field">
            <input id="password" type={visible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy || !!problem} />
            <button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? ui.text("隐藏密码", "Hide password") : ui.text("显示密码", "Show password")}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </div>
          {(problem || error || authError) && <p className="inline-error" role="alert">{problem || error || authError}</p>}
          <Button type="submit" disabled={busy || !!problem}>
            {busy && <LoaderCircle className="spin" size={17} />}
            {busy ? ui.text("正在登录", "Signing in") : ui.text("进入工作空间", "Enter workspace")}<ArrowRight size={17} />
          </Button>
        </form>
        <div className="auth-switch">{ui.text("还没有账户？", "New here?")} <Link href="/register">{ui.text("创建账户", "Create account")}</Link></div>
        <div className="login-demo-note"><small>{ui.text("首次进入后，在模型设置中连接你的模型。", "After signing in, connect your model in Settings.")}</small></div>
      </div>
      <p className="login-footer">{ui.text("把想法，织成应用。", "Weave your ideas into apps.")}</p>
    </main>
  );
}
export function LoginPage() { return isDemoMode ? <DemoLogin /> : <ApiLoginPage />; }
