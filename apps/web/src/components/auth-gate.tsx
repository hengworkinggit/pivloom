"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { demoApi } from "@/lib/mock-api";
import { errorMessage } from "@/lib/utils";
import { Button } from "./ui/button";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    demoApi
      .getSession()
      .then((session) => {
        if (!active) return;
        if (session) setReady(true);
        else router.replace("/login");
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [router]);
  if (error)
    return (
      <main className="standalone-state">
        <h1>暂时无法读取演示数据</h1>
        <p role="alert">{error}</p>
        <Button onClick={() => location.reload()}>重试</Button>
      </main>
    );
  if (!ready)
    return (
      <main className="page-loader" aria-label="正在打开工作空间">
        <LoaderCircle className="spin" size={22} />
      </main>
    );
  return children;
}
