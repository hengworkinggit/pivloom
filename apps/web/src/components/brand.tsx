import Link from "next/link";
import { cn } from "@/lib/utils";

export function LoomMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn("loom-mark", className)}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m13 5 4-2a4 4 0 0 1 5.3 1.4l3.9 6.8a4 4 0 0 1-1.4 5.4l-6.2 3.6"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="m27 18 2 4a4 4 0 0 1-1.4 5.3l-6.8 3.9a4 4 0 0 1-5.4-1.4l-3.6-6.2"
        transform="translate(-2 -3)"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="m19 27-4 2a4 4 0 0 1-5.3-1.4l-3.9-6.8a4 4 0 0 1 1.4-5.4l6.2-3.6M5 14l-2-4a4 4 0 0 1 1.4-5.3l6.8-3.9a4 4 0 0 1 5.4 1.4l3.6 6.2"
        transform="translate(1 1) scale(.92)"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="m12 19 8-7"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <Link
      href="/projects"
      className={cn("brand", small && "brand-small")}
      aria-label="Pivloom 项目首页"
    >
      <LoomMark />
      <span>
        Pivloom<span className="brand-period">.</span>
      </span>
    </Link>
  );
}
