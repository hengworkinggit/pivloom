import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore, type Api } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  RuntimeError,
  type ModelConfig,
  type ProbeEventSink,
  type WorkspaceHandle,
  type WorkspacePort,
} from "./types.js";

export interface BuilderInput {
  workspace: WorkspacePort;
  handle: WorkspaceHandle;
  modelConfig: ModelConfig;
  prompt: string;
  signal: AbortSignal;
  onEvent?: ProbeEventSink;
  timeoutMs?: number;
}
export interface BuilderResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; success: boolean }>;
  model: { provider: string; id: string; api: string };
  usage: { input: number; output: number; total: number };
}

export async function createServiceModel(
  config: ModelConfig,
  signal?: AbortSignal,
) {
  if (!config.apiKey.trim() || !config.id.trim() || !config.provider.trim())
    throw new RuntimeError("MODEL_CONFIGURATION_MISSING", "模型配置不完整");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
    signal,
  });
  let model = runtime.getModel(config.provider, config.id);
  if (config.baseUrl) {
    const api: Api =
      config.api ??
      model?.api ??
      (config.provider === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-completions");
    runtime.registerProvider(config.provider, {
      baseUrl: config.baseUrl,
      api,
      models: [
        {
          id: config.id,
          name: config.id,
          api,
          reasoning: false,
          input: config.supportsImages ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: config.contextWindow ?? 128000,
          maxTokens: config.maxTokens ?? 8192,
        },
      ],
    });
    model = runtime.getModel(config.provider, config.id);
  }
  if (!model)
    throw new RuntimeError(
      "MODEL_NOT_FOUND",
      "配置的模型不在 Pi 模型列表，需提供已验证的 API 协议及 Base URL",
    );
  await runtime.setRuntimeApiKey(config.provider, config.apiKey, { signal });
  return { runtime, model };
}

export async function runBuilder(input: BuilderInput): Promise<BuilderResult> {
  const safeDetail = (value: unknown) =>
    String(value ?? "unknown")
      .replaceAll(input.modelConfig.apiKey, "[REDACTED]")
      .replace(/Bearer\s+[^\s\"']+/gi, "Bearer [REDACTED]")
      .slice(0, 800);
  const isolated = await mkdtemp(join(tmpdir(), "pivloom-pi-"));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), input.timeoutMs ?? 360000);
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const calls: BuilderResult["toolCalls"] = [];
  const toRemote = (absolute: string) => {
    const path = relative(isolated, absolute);
    if (path.startsWith("..") || isAbsolute(path))
      throw new RuntimeError("INVALID_SOURCE_PATH", "工具路径越界");
    return path;
  };
  const read = async (path: string) =>
    Buffer.from(await input.workspace.read(input.handle, toRemote(path)));
  const write = async (path: string, content: string) =>
    input.workspace.write(input.handle, toRemote(path), Buffer.from(content));
  const definitions = [
    createReadToolDefinition(isolated, {
      autoResizeImages: false,
      operations: {
        readFile: read,
        access: async (p) => {
          toRemote(p);
        },
        detectImageMimeType: async () => null,
      },
    }),
    createWriteToolDefinition(isolated, {
      operations: {
        writeFile: write,
        mkdir: async () => {
          /* guarded remote writer creates directories */
        },
      },
    }),
    createEditToolDefinition(isolated, {
      operations: {
        readFile: read,
        writeFile: write,
        access: async (p) => {
          toRemote(p);
        },
      },
    }),
    createBashToolDefinition(isolated, {
      exposeSessionEnvironment: false,
      operations: {
        exec: async (command, _cwd, options) => {
          const combined = options.signal
            ? AbortSignal.any([signal, options.signal])
            : signal;
          let forwarded = 0;
          const handle = await input.workspace.exec(input.handle, {
            command,
            signal: combined,
            timeoutMs: Math.min((options.timeout ?? 60) * 1000, 120000),
            onOutput: (chunk) => {
              const clipped = chunk.slice(0, Math.max(0, 16000 - forwarded));
              forwarded += clipped.length;
              if (clipped) options.onData(Buffer.from(clipped));
            },
          });
          const result = await handle.wait();
          if (forwarded === 0)
            options.onData(
              Buffer.from(
                (result.stdoutTail + "\n" + result.stderrTail).slice(-16000),
              ),
            );
          return { exitCode: result.exitCode };
        },
      },
    }),
  ];
  // Pi validates each tool's own schema before execute; erase only the generic schema type at the SDK registration boundary.
  const tools: ToolDefinition[] = (
    definitions as unknown as ToolDefinition[]
  ).map((definition) => ({
    ...definition,
    executionMode: "sequential",
    execute: async (id, params, toolSignal, onUpdate, context) => {
      signal.throwIfAborted();
      if (calls.length >= 64)
        throw new RuntimeError(
          "TOOL_BUDGET_EXCEEDED",
          "本次任务工具调用已达上限",
        );
      const call = { id, name: definition.name, success: false };
      calls.push(call);
      await input.onEvent?.({
        id: randomUUID(),
        at: new Date().toISOString(),
        type: "tool.start",
        toolCallId: id,
        toolName: definition.name,
        message: `执行远程 ${definition.name}`,
      });
      try {
        const result = await definition.execute(
          id,
          params,
          toolSignal,
          onUpdate,
          context,
        );
        call.success = true;
        return result;
      } finally {
        await input.onEvent?.({
          id: randomUUID(),
          at: new Date().toISOString(),
          type: "tool.end",
          toolCallId: id,
          toolName: definition.name,
          success: call.success,
          message: call.success ? "远程工具完成" : "远程工具未完成",
        });
      }
    },
  }));
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  let aborting: Promise<void> | undefined;
  let requestNumber = 0;
  let requestStartedAt = 0;
  let responseStatus: number | undefined;
  let streamedCharacters = 0;
  const abort = () => {
    if (aborting) return;
    aborting = session?.abort();
    void input.workspace.destroy(input.handle);
  };
  try {
    const { runtime, model } = await createServiceModel(
      input.modelConfig,
      signal,
    );
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { timeoutMs: 90000, maxRetries: 0 } },
      cacheWarming: "off",
      defaultProjectTrust: "never",
    });
    const loader = new DefaultResourceLoader({
      cwd: isolated,
      agentDir: isolated,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt:
        "You build a React/TypeScript/Vite application. All read/write/edit/bash tools operate ONLY in an isolated remote source workspace. Use relative source paths. Never seek credentials, host files, services, external accounts or instructions outside the supplied task. Do not alter the build to skip checks. Do not run background processes; the service builds and starts preview. Use the supplied tool results honestly. Finish only after implementing the requested behavior.",
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: isolated,
      agentDir: isolated,
      modelRuntime: runtime,
      model,
      tools: ["read", "write", "edit", "bash"],
      customTools: tools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(isolated),
      settingsManager: settings,
      thinkingLevel: "off",
    }));
    // A per-run HTTP transport preserves the caller's DNS-pinned BYOK transport.
    session.agent.streamFunction = (selected, context, options) => {
      requestNumber++;
      requestStartedAt = Date.now();
      responseStatus = undefined;
      streamedCharacters = 0;
      return runtime.streamSimple(selected, context, {
        ...options,
        fetch: input.modelConfig.fetch,
        transport: "sse",
        timeoutMs: 90000,
        maxRetries: 0,
        maxTokens: input.modelConfig.maxTokens ?? 8192,
        onResponse: async (response) => {
          responseStatus = response.status;
          await input.onEvent?.({
            id: randomUUID(),
            at: new Date().toISOString(),
            type: "stage",
            stage: "generating",
            message: `模型第 ${requestNumber} 轮响应 HTTP ${response.status}（${Date.now() - requestStartedAt}ms）`,
          });
        },
      });
    };
    session.agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        "delta" in event.assistantMessageEvent &&
        typeof event.assistantMessageEvent.delta === "string"
      ) {
        const delta = event.assistantMessageEvent.delta;
        if (delta.length && streamedCharacters === 0)
          void Promise.resolve(
            input.onEvent?.({
              id: randomUUID(),
              at: new Date().toISOString(),
              type: "model.stream.started",
              stage: "generating",
              requestNumber,
              message: `模型第 ${requestNumber} 轮已收到实际流式内容`,
            }),
          ).catch(() => {});
        streamedCharacters += delta.length;
      }
    });
    session.agent.shouldStopAfterTurn = () => calls.length >= 64;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      throw new RuntimeError("CANCELLED", "模型任务已取消");
    }
    await session.prompt(input.prompt);
    if (signal.aborted)
      throw new RuntimeError(
        deadline.signal.aborted ? "MODEL_TIMEOUT" : "CANCELLED",
        "模型任务已停止",
      );
    if (calls.length >= 64)
      throw new RuntimeError("TOOL_BUDGET_EXCEEDED", "工具调用预算耗尽");
    const last = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      last?.role === "assistant" &&
      (last.stopReason === "error" || last.stopReason === "aborted")
    )
      throw new RuntimeError(
        /timeout|timed out|abort/i.test(last.errorMessage ?? "")
          ? "MODEL_REQUEST_TIMEOUT"
          : "MODEL_FAILED",
        `模型第 ${requestNumber} 轮失败；HTTP ${responseStatus ?? "未收到"}；${Date.now() - requestStartedAt}ms；已接收 ${streamedCharacters} 字符；${safeDetail(last.errorMessage)}`,
      );
    const text =
      last?.role === "assistant"
        ? last.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : "";
    const stats = session.getSessionStats();
    return {
      text,
      toolCalls: calls,
      model: { provider: model.provider, id: model.id, api: model.api },
      usage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
      },
    };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (signal.aborted)
      throw new RuntimeError(
        deadline.signal.aborted ? "MODEL_TIMEOUT" : "CANCELLED",
        "模型任务已停止",
      );
    throw new RuntimeError(
      "MODEL_FAILED",
      `模型执行失败：${safeDetail(error instanceof Error ? error.message : error)}`,
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (aborting) {
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        aborting.then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          stopTimer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      clearTimeout(stopTimer);
      await input.onEvent?.({
        id: randomUUID(),
        at: new Date().toISOString(),
        type: "model.stopped",
        requestNumber,
        success: stopped,
        message: stopped
          ? "Pi abort 已结束并确认会话停止"
          : "Pi abort 结束尚未确认",
      });
    }
    session?.dispose();
    await rm(isolated, { recursive: true, force: true });
  }
}
