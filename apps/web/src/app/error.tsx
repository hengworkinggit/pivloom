"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="standalone-state">
      <h1>页面暂时遇到了一点问题</h1>
      <p>重新载入页面后再试一次。</p>
      <Button onClick={reset}>重新载入</Button>
    </main>
  );
}
