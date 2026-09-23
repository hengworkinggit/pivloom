import { randomUUID } from "node:crypto";
import { HandoffSchema, type Handoff } from "@pivloom/contracts";
import {
  SandboxApiException,
  SandboxManager,
} from "@alibaba-group/opensandbox";
import {
  buildAndPreview,
  initializeReactWorkspace,
} from "../runtime/generation.js";
import { runBuilder, type BuilderResult } from "../runtime/pi.js";
import type { RunTokenBudget } from "../runtime/token-budget.js";
import { RUN_DEADLINE_MINUTES, RUN_DEADLINE_MS } from "../runtime/budgets.js";
import { createSourceSnapshot } from "../runtime/snapshot.js";
import {
  OpenSandboxWorkspace,
  sandboxConnectionConfig,
  type SandboxConnector,
} from "../runtime/workspace.js";
import {
  RuntimeError,
  type ModelConfig,
  type ProbeEvent,
  type ProbeEventSink,
  type SandboxConfig,
  type SourceFile,
  type TrustedBuildRecord,
  type TrustedCommandRecord,
  type WorkspaceHandle,
} from "../runtime/types.js";

export type CandidateSnapshot = ReturnType<typeof createSourceSnapshot>;
export type CandidateManifest = Array<{
  path: string;
  sha256: string;
  bytes: number;
}>;

/** Private backend lifecycle data. Endpoint credentials must never enter SSE or public DTOs. */
export interface CandidateSandboxRegistration extends WorkspaceHandle {
  state:
    | "created"
    | "preview_ready"
    | "retained"
    | "destroyed"
    | "cleanup_pending";
  revisionId: string;
  sourceHash?: string;
  endpoint?: { port: 4173; url: string; headers: Record<string, string> };
}

export interface RunCandidateInput {
  runId: string;
  revisionId: string;
  roleRunId?: string;
  sessionId?: string;
  previewBasePath?: string;
  prompt: string;
  handoff?: Handoff;
  /** Repair attempts start from the previous immutable snapshot, not a blank template. */
  seed?: SourceFile[];
  maxToolCalls?: number;
  tokenBudget?: RunTokenBudget;
  modelConfig: ModelConfig;
  sandboxConfig: SandboxConfig;
  signal: AbortSignal;
  onEvent?: ProbeEventSink;
  onSandbox?: (registration: CandidateSandboxRegistration) => Promise<void>;
}

interface CandidateResultBase {
  runId: string;
  revisionId: string;
  elapsedMs: number;
  toolCalls: BuilderResult["toolCalls"];
  usage?: BuilderResult["usage"];
  trustedBuild?: TrustedBuildRecord;
}

export type RunCandidateResult = CandidateResultBase &
  (
    | {
        status: "candidate";
        trustedBuild: TrustedBuildRecord;
        snapshot: CandidateSnapshot;
        manifest: CandidateManifest;
        preview: WorkspaceHandle & {
          revisionId: string;
          sourceHash: string;
          upstreamUrl: string;
          headers: Record<string, string>;
          basePath: string;
        };
        cleanup: "retained";
      }
    | {
        status: "failed" | "cancelled" | "cleanup_pending";
        error: { code: string; message: string };
        sandboxId?: string;
        cleanup: "confirmed" | "pending" | "not_created";
        diagnosticSnapshot?: CandidateSnapshot;
        diagnosticBuildStatus?: "passed" | "failed";
        manifest?: CandidateManifest;
      }
  );

/** Produces an unreviewed candidate; saving and any later promotion belong to the caller. */
export interface CandidateBoundaries {
  sandboxConnector?: SandboxConnector;
  /** Isolated test startup only; production never supplies an output adapter. */
  afterBuilderOutput?(context: {
    runId: string; attempt: number; workspace: OpenSandboxWorkspace;
    handle: WorkspaceHandle; signal: AbortSignal;
  }): Promise<void>;
}

export async function runCandidate(
  input: RunCandidateInput,
  boundaries: CandidateBoundaries = {},
): Promise<RunCandidateResult> {
  const started = Date.now();
  const deadline = new AbortController();
  const eventAbort = new AbortController();
  const timer = setTimeout(() => deadline.abort(), RUN_DEADLINE_MS);
  const signal = AbortSignal.any([
    input.signal,
    deadline.signal,
    eventAbort.signal,
  ]);
  const workspace = new OpenSandboxWorkspace(
    {
      ...input.sandboxConfig,
      lifetimeMs: input.sandboxConfig.lifetimeMs ?? RUN_DEADLINE_MS,
    },
    boundaries.sandboxConnector,
  );
  let handle: WorkspaceHandle | undefined;
  let retained = false;
  let eventFailure = false;
  let eventTail = Promise.resolve();
  const toolCalls: BuilderResult["toolCalls"] = [];
  let usage: BuilderResult["usage"] | undefined;
  let trustedBuild: TrustedBuildRecord | undefined;
  let buildStarted = false;
  const eventError = () =>
    new RuntimeError("EVENT_APPEND_FAILED", "运行事件保存失败，已停止候选生成");
  const sink = (event: ProbeEvent): Promise<void> => {
    if (event.type === "tool.end" && event.toolCallId && event.toolName)
      toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        success: event.success === true,
      });
    const operation = eventTail.then(async () => {
      if (eventFailure) throw eventError();
      try {
        await input.onEvent?.({
          ...event,
          roleRunId: input.roleRunId,
          sessionId: input.sessionId,
        });
      } catch {
        eventFailure = true;
        eventAbort.abort();
        throw eventError();
      }
    });
    eventTail = operation.catch(() => {});
    return operation;
  };
  const emit = (event: Omit<ProbeEvent, "id" | "at">) =>
    sink({
      ...event,
      id: randomUUID(),
      at: new Date().toISOString(),
    });
  const flush = async () => {
    await eventTail;
    if (eventFailure) throw eventError();
  };
  const register = async (registration: CandidateSandboxRegistration) => {
    try {
      await input.onSandbox?.(registration);
    } catch {
      throw new RuntimeError(
        "SANDBOX_REGISTRATION_FAILED",
        "沙箱生命周期保存失败",
      );
    }
  };
  const resultBase = (): CandidateResultBase => ({
    runId: input.runId,
    revisionId: input.revisionId,
    elapsedMs: Date.now() - started,
    toolCalls,
    usage,
    trustedBuild,
  });
  const redact = (value: string) => {
    for (const secret of [input.modelConfig.apiKey, input.sandboxConfig.apiKey]) if (secret) value = value.replaceAll(secret, "[REDACTED]");
    return value.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  };
  const logTail = (value: string) => {
    const bytes = Buffer.from(redact(value));
    let start = Math.max(0, bytes.length - 2048);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  };
  const safeBuild = (record: TrustedBuildRecord): TrustedBuildRecord => {
    const command = (value: TrustedCommandRecord | null): TrustedCommandRecord | null => value && ({
      command: redact(value.command), exitCode: value.exitCode, durationMs: value.durationMs,
      stdoutTail: logTail(value.stdoutTail), stderrTail: logTail(value.stderrTail),
    });
    return { schemaVersion: 1, sourceHash: record.sourceHash, typecheck: command(record.typecheck), build: command(record.build) };
  };
  const snapshotSources = (files: SourceFile[]) => {
    const snapshot = createSourceSnapshot(files);
    if (snapshot.bundle.files.some((file) => file.content.includes("\0")))
      throw new RuntimeError(
        "UNSUPPORTED_SOURCE_ENCODING",
        "源码包含不支持的二进制内容",
      );
    for (const secret of [input.modelConfig.apiKey, input.sandboxConfig.apiKey])
      if (
        secret &&
        snapshot.bundle.files.some((file) => file.content.includes(secret))
      )
        throw new RuntimeError(
          "SENSITIVE_SOURCE_DATA",
          "源码包含服务凭据，不能保存或预览",
        );
    const manifest = snapshot.bundle.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: Buffer.byteLength(file.content),
    }));
    return { snapshot, manifest };
  };
  let failure: Extract<RunCandidateResult, { error: unknown }> | undefined;
  try {
    if (!input.prompt.trim() || input.prompt.length > 8_000)
      throw new RuntimeError("INVALID_PROMPT", "需求必须为 1–8000 个字符");
    const handoff = input.handoff ? HandoffSchema.parse(input.handoff) : undefined;
    if (handoff && (handoff.runId !== input.runId || handoff.toRole !== "builder"))
      throw new RuntimeError("INVALID_HANDOFF", "交接目标与当前生成任务不一致");
    const builderPrompt = handoff
      ? `${handoff.task}\n\n已保存的实现目标与行为约定：\n${JSON.stringify(handoff.plan)}${handoff.failedChecks?.length ? `\n\n上一轮实际失败与诊断（逐项修复，不可忽略）：\n${JSON.stringify(handoff.failedChecks)}` : ""}`
      : input.prompt;
    signal.throwIfAborted();
    await emit({
      type: "stage",
      stage: "creating",
      message: "创建独立候选沙箱",
    });
    handle = await workspace.create({
      runId: input.runId,
      signal,
      onCreated: async (created) => {
        handle = created;
        await register({
          ...created,
          state: "created",
          revisionId: input.revisionId,
        });
      },
    });
    await emit({
      type: "resource.created",
      sandboxId: handle.sandboxId,
      message: "候选沙箱已登记",
    });
    await initializeReactWorkspace(workspace, handle, input.seed);
    signal.throwIfAborted();
    await emit({
      type: "stage",
      stage: "generating",
      message: "Builder 正在实现你的需求",
    });
    const built = await runBuilder({
      workspace,
      handle,
      modelConfig: input.modelConfig,
      prompt: builderPrompt,
      signal,
      onEvent: sink,
      timeoutMs: Math.max(1, RUN_DEADLINE_MS - (Date.now() - started)),
      maxToolCalls: input.maxToolCalls ?? 80,
      tokenBudget: input.tokenBudget,
      sessionId: input.sessionId,
      redactValues: [input.sandboxConfig.apiKey],
    });
    usage = built.usage;
    await flush();
    signal.throwIfAborted();
    await boundaries.afterBuilderOutput?.({ runId: input.runId, attempt: handoff?.attempt ?? 0, workspace, handle, signal });
    signal.throwIfAborted();
    await emit({
      type: "stage",
      stage: "building",
      message: "执行固定 TypeScript 检查与生产构建",
    });
    buildStarted = true;
    const candidate = await buildAndPreview(
      workspace,
      handle,
      input.revisionId,
      {
        signal,
        buildTimeoutMs: 90_000,
        previewBasePath: input.previewBasePath,
      },
    );
    trustedBuild = safeBuild(candidate.trustedBuild);
    const { snapshot, manifest } = snapshotSources(candidate.files);
    const registration: CandidateSandboxRegistration = {
      ...handle,
      state: "preview_ready",
      revisionId: input.revisionId,
      sourceHash: snapshot.sourceHash,
      endpoint: {
        port: 4173,
        url: candidate.upstreamUrl,
        headers: candidate.headers,
      },
    };
    await register(registration);
    await emit({
      type: "stage",
      stage: "previewing",
      message: "候选构建和版本标记已通过，等待保存；尚未进行业务检查",
    });
    await flush();
    signal.throwIfAborted();
    await register({ ...registration, state: "retained" });
    signal.throwIfAborted();
    await workspace.releaseClient(handle);
    signal.throwIfAborted();
    retained = true;
    return {
      ...resultBase(),
      status: "candidate",
      trustedBuild,
      snapshot,
      manifest,
      cleanup: "retained",
      preview: {
        ...handle,
        revisionId: input.revisionId,
        sourceHash: snapshot.sourceHash,
        upstreamUrl: candidate.upstreamUrl,
        headers: candidate.headers,
        basePath: input.previewBasePath ?? "/",
      },
    };
  } catch (error) {
    if (error instanceof RuntimeError && error.trustedBuild) trustedBuild = safeBuild(error.trustedBuild);
    if (error instanceof RuntimeError && error.usage) usage = { ...error.usage };
    const timedOut = deadline.signal.aborted || input.signal.aborted && input.signal.reason === "RUN_TIMEOUT";
    const runtimeError = timedOut
      ? new RuntimeError("RUN_TIMEOUT", `本次生成超过 ${RUN_DEADLINE_MINUTES} 分钟，已停止`)
      : eventFailure
      ? eventError()
      : input.signal.aborted
        ? new RuntimeError("CANCELLED", "候选生成已停止")
        : error instanceof RuntimeError
            ? error
            : new RuntimeError(
                "CANDIDATE_FAILED",
                "候选生成未完成，请查看失败阶段后重试",
              );
    let message = runtimeError.message;
    for (const secret of [input.modelConfig.apiKey, input.sandboxConfig.apiKey])
      if (secret) message = message.replaceAll(secret, "[REDACTED]");
    failure = {
      ...resultBase(),
      status: input.signal.aborted && !timedOut ? "cancelled" : "failed",
      error: {
        code: runtimeError.code,
        message: message
          .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
          .slice(0, 2000),
      },
      sandboxId: handle?.sandboxId,
      cleanup: "not_created",
    };
    if (
      buildStarted &&
      handle &&
      !signal.aborted &&
      [
        "TYPECHECK_FAILED",
        "BUILD_FAILED",
        "PREVIEW_START_FAILED",
        "SOURCE_CHANGED_DURING_BUILD",
      ].includes(runtimeError.code)
    ) {
      try {
        await workspace.revokeWriters(handle);
        const saved = snapshotSources(await workspace.listSourceFiles(handle));
        failure.diagnosticSnapshot = saved.snapshot;
        failure.diagnosticBuildStatus = trustedBuild?.sourceHash === saved.snapshot.sourceHash
          && trustedBuild.typecheck?.exitCode === 0 && trustedBuild.build?.exitCode === 0 ? "passed" : "failed";
        failure.manifest = saved.manifest;
      } catch {
        // Unsafe or unavailable files cannot become a diagnostic revision.
      }
    }
  } finally {
    clearTimeout(timer);
    if (!retained && handle) {
      const cleanup = await workspace.destroy(handle);
      if (failure) {
        failure.cleanup = cleanup.confirmed ? "confirmed" : "pending";
        if (!cleanup.confirmed) failure.status = "cleanup_pending";
      }
      await register({
        ...handle,
        state: cleanup.confirmed ? "destroyed" : "cleanup_pending",
        revisionId: input.revisionId,
      }).catch(() => {});
      await emit({
        type: "resource.cleaned",
        sandboxId: handle.sandboxId,
        success: cleanup.confirmed,
        message: cleanup.confirmed
          ? "候选沙箱已确认销毁"
          : "候选沙箱清理待确认",
      }).catch(() => {});
    }
    await eventTail;
  }
  return { ...failure!, elapsedMs: Date.now() - started };
}

/** Caller must supply a sandbox ID from its own persisted candidate registration. */
export async function destroyCandidateSandbox(input: {
  sandboxConfig: SandboxConfig;
  sandboxId: string;
}): Promise<{ confirmed: boolean }> {
  const manager = SandboxManager.create({
    connectionConfig: sandboxConnectionConfig(input.sandboxConfig),
  });
  try {
    try {
      await manager.killSandbox(input.sandboxId);
    } catch (error) {
      if (!(error instanceof SandboxApiException && error.statusCode === 404))
        throw error;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await manager.getSandboxInfo(input.sandboxId);
      } catch (error) {
        if (error instanceof SandboxApiException && error.statusCode === 404)
          return { confirmed: true };
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return { confirmed: false };
  } catch {
    return { confirmed: false };
  } finally {
    await manager.close().catch(() => {});
  }
}
