"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { getWorkspaceAuth } from "@/lib/workspace";
import { errorMessage } from "@/lib/utils";

export function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@pivloom.app");
  const [password, setPassword] = useState("demo1234");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="login-page">
      <Brand />
      <div className="login-card">
        <div className="hero-eyebrow">WELCOME BACK</div>
        <h1>继续编织你的想法</h1>
        <p>登录 Pivloom，回到你的创作空间。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            setBusy(true);
            try {
              await getWorkspaceAuth().login(email, password);
              router.replace("/projects");
            } catch (e) {
              setError(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
          <label htmlFor="password">密码</label>
          <div className="password-field">
            <input
              id="password"
              type={visible ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "隐藏密码" : "显示密码"}
            >
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : null}
            进入工作空间
            <ArrowRight size={17} />
          </Button>
        </form>
        <div className="login-demo-note">
          <span className="demo-badge">演示账号</span>
          <p>
            demo@pivloom.app <span> / </span> demo1234
          </p>
          <small>所有数据均为本地模拟数据，无需注册。</small>
        </div>
      </div>
      <p className="login-footer">把想法，织成应用。</p>
    </main>
  );
}
