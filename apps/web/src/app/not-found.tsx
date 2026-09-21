import Link from "next/link";
import { Brand } from "@/components/brand";
export default function NotFound() {
  return (
    <main className="standalone-state">
      <Brand />
      <span className="eyebrow">404</span>
      <h1>这个页面还没有被织出来</h1>
      <p>回到项目首页，继续你的想法。</p>
      <Link
        className="pv-button pv-button-primary pv-button-default"
        href="/projects"
      >
        返回我的项目
      </Link>
    </main>
  );
}
