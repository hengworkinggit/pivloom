"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { configurationProblem, isDemoMode } from "@/lib/workspace";
import { useWorkspaceAuth } from "@/lib/use-workspace";
import { errorMessage } from "@/lib/utils";

const DemoLogin = dynamic(() => import("./demo-login-page").then((module) => module.LoginPage));

function ApiLoginPage() {
  const router = useRouter();
  const { auth, status, error: authError } = useWorkspaceAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const problem = configurationProblem();
  useEffect(() => { if (status === "authenticated") router.replace("/projects"); }, [status, router]);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || problem) return;
    submitting.current = true;
    setError(""); setBusy(true);
    try {
      await auth.login(email, password);
      setPassword("");
      router.replace("/projects");
    } catch (error) { setError(errorMessage(error)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return (
    <main className="login-page">
      <Brand />
      <div className="login-card">
        <div className="hero-eyebrow">WELCOME BACK</div>
        <h1>继续编织你的想法</h1>
        <p>登录 Pivloom，回到你的创作空间。</p>
        <form onSubmit={(event) => void login(event)}>
          <label htmlFor="email">邮箱</label>
          <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required disabled={busy || !!problem} />
          <label htmlFor="password">密码</label>
          <div className="password-field">
            <input id="password" type={visible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy || !!problem} />
            <button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? "隐藏密码" : "显示密码"}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </div>
          {(problem || error || authError) && <p className="inline-error" role="alert">{problem || error || authError}</p>}
          <Button type="submit" disabled={busy || !!problem}>
            {busy && <LoaderCircle className="spin" size={17} />}
            {busy ? "正在登录" : "进入工作空间"}<ArrowRight size={17} />
          </Button>
        </form>
        <div className="login-demo-note"><small>请使用你的体验账号登录。首次进入后，在模型设置中连接你的模型。</small></div>
      </div>
      <p className="login-footer">把想法，织成应用。</p>
    </main>
  );
}
export function LoginPage() { return isDemoMode ? <DemoLogin /> : <ApiLoginPage />; }
