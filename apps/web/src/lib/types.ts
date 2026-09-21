export type ProjectKind = "events" | "books" | "portfolio";

export type RunPhase =
  | "planning"
  | "building"
  | "checking"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped";

export interface Activity {
  role: "coordinator" | "builder" | "reviewer";
  status: "pending" | "running" | "completed" | "failed";
  detail: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  activities?: Activity[];
  revision?: number;
}

export interface SourceFile {
  path: string;
  language: string;
  content: string;
}

export interface Run {
  id: string;
  phase: RunPhase;
  prompt: string;
  startedAt: string;
  activities: Activity[];
  error?: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  kind: ProjectKind;
  updatedAt: string;
  revision: number;
  status: "ready" | "running" | "failed" | "stopped" | "expired";
  messages: ChatMessage[];
  files: SourceFile[];
  activeRun?: Run;
  features: string[];
}

export interface Session {
  name: string;
  email: string;
}
