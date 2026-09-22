"use client";

import dynamic from "next/dynamic";
import { isDemoMode } from "@/lib/workspace";
import { ApiWorkbench } from "./api-workbench";

const DemoWorkbench = dynamic(() => import("./demo-workbench").then((module) => module.Workbench));
export function Workbench({ projectId }: { projectId: string }) {
  return isDemoMode ? <DemoWorkbench projectId={projectId} /> : <ApiWorkbench projectId={projectId} />;
}
