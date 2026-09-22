"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { useWorkspaceAuth } from "@/lib/use-workspace";
import { Button } from "./ui/button";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status, error, epoch, auth } = useWorkspaceAuth();
  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);
  if (status === "error")
    return (
      <main className="standalone-state">
        <h1>工作空间暂时无法打开</h1>
        <p role="alert">{error}</p>
        <Button onClick={() => void auth.retry()}>重试</Button>
      </main>
    );
  if (status !== "authenticated")
    return (
      <main className="page-loader" aria-label="正在打开工作空间">
        <LoaderCircle className="spin" size={22} />
      </main>
    );
  return <div key={epoch} className="authenticated-workspace">{children}</div>;
}
