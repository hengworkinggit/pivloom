import type { Api } from "@earendil-works/pi-ai";
import type { TokenUsage } from "./token-budget.js";

export interface ModelConfig {
  provider: string;
  id: string;
  apiKey: string;
  baseUrl?: string;
  api?: Api;
  supportsImages?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

export interface SandboxConfig {
  baseUrl: string;
  apiKey: string;
  image: string;
  lifetimeMs?: number;
  previewBaseUrl?: string;
  /** Enables the installed Node/agent-browser program transport; legacy adapters may leave it unset. */
  browserPrograms?: boolean;
}

export interface ProbeEvent {
  id: string;
  at: string;
  roleRunId?: string;
  sessionId?: string;
  type:
    | "stage"
    | "tool.start"
    | "tool.output"
    | "tool.end"
    | "resource.created"
    | "resource.cleaned"
    | "model.stream.started"
    | "model.stopped"
    | "browser.action";
  stage?:
    | "creating"
    | "generating"
    | "building"
    | "previewing"
    | "checking"
    | "ready"
    | "cleaning";
  message: string;
  toolName?: string;
  toolCallId?: string;
  sandboxId?: string;
  exitCode?: number;
  success?: boolean;
  requestNumber?: number;
  truncated?: boolean;
}

export type ProbeEventSink = (event: ProbeEvent) => void | Promise<void>;

export interface PreviewBinding {
  sandboxId: string;
  url: string;
  revisionId: string;
  sourceHash: string;
  expiresAt: string;
}

export interface ProbeCleanup {
  state: "not_created" | "retained_until_expiry" | "confirmed" | "pending";
  sandboxId?: string;
  expiresAt?: string;
}

export interface ProbeResult {
  status: "ready" | "failed" | "cancelled" | "cleanup_pending";
  runId: string;
  preview?: PreviewBinding;
  events: ProbeEvent[];
  evidence: {
    model: {
      provider: string;
      id: string;
      api?: string;
      imageCapability: "unverified" | "dom_only";
    };
    versions: Record<string, string>;
    toolCalls: Array<{ id: string; name: string; success: boolean }>;
    checks: Array<{
      name: string;
      status: "PASS" | "FAIL" | "BLOCKED";
      detail: string;
    }>;
    sources?: Array<{ path: string; sha256: string; bytes: number }>;
    screenshot?: { base64: string; mimeType: "image/png"; sha256: string };
    elapsedMs: number;
  };
  error?: { code: string; message: string };
  cleanup: ProbeCleanup;
}

export interface RunProbeInput {
  prompt: string;
  modelConfig: ModelConfig;
  sandboxConfig: SandboxConfig;
  signal?: AbortSignal;
  onEvent?: ProbeEventSink;
  publishPreview?: (
    input: PreviewBinding & {
      upstreamUrl: string;
      headers: Record<string, string>;
    },
  ) => Promise<string>;
}

export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly trustedBuild?: TrustedBuildRecord,
    public readonly usage?: TokenUsage,
    public readonly diagnosticCode?: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export interface WorkspaceHandle {
  sandboxId: string;
  expiresAt: string;
}

export interface RemoteCommand {
  command: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface CommandResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface TrustedCommandRecord {
  command: string;
  // Null means the command did not return an exit status; it never implies success.
  exitCode: number | null;
  durationMs: number | null;
  stdoutTail: string;
  stderrTail: string;
}

export interface TrustedBuildRecord {
  schemaVersion: 1;
  sourceHash: string | null;
  typecheck: TrustedCommandRecord | null;
  build: TrustedCommandRecord | null;
}

export interface CommandHandle {
  id: string;
  wait(): Promise<CommandResult>;
  cancel(): Promise<{ confirmed: boolean }>;
}

export interface SourceFile {
  path: string;
  content: Uint8Array;
  sha256: string;
}

export interface WorkspacePort {
  create(input: {
    runId: string;
    signal: AbortSignal;
    onCreated?: (handle: WorkspaceHandle) => Promise<void>;
  }): Promise<WorkspaceHandle>;
  read(handle: WorkspaceHandle, relativePath: string): Promise<Uint8Array>;
  write(
    handle: WorkspaceHandle,
    relativePath: string,
    data: Uint8Array,
  ): Promise<void>;
  listSourceFiles(handle: WorkspaceHandle): Promise<SourceFile[]>;
  exec(handle: WorkspaceHandle, command: RemoteCommand): Promise<CommandHandle>;
  destroy(handle: WorkspaceHandle): Promise<{ confirmed: boolean }>;
}
