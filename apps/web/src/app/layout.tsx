import type { Metadata } from "next";
import "./globals.css";
import "./a-interface.css";
import "./a-model-settings.css";
import "./a-templates.css";
import "./a-auth-account.css";
import "./a-task-queue.css";

export const metadata: Metadata = {
  title: "Pivloom · 派织",
  description: "把想法，织成应用。AI 应用构建工作台交互演示。",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
