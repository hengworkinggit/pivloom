import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  type ProbeEvent,
  type ProbeEventSink,
  type WorkspaceHandle,
  type WorkspacePort,
} from "./types.js";
import { createToolOutput } from "./tool-output.js";
import { createRoleTokenTracker, type RunTokenBudget, type TokenUsage } from "./token-budget.js";
import { MODEL_REQUEST_TIMEOUT_MS, piCompactionSettings, providerRetrySettings } from "./budgets.js";

export interface BuilderInput {
  workspace: WorkspacePort;
  handle: WorkspaceHandle;
  modelConfig: ModelConfig;
  prompt: string;
  signal: AbortSignal;
  onEvent?: ProbeEventSink;
  maxToolCalls?: number;
  sessionId?: string;
  redactValues?: readonly string[];
  tokenBudget?: RunTokenBudget;
}
export interface BuilderResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; success: boolean }>;
  model: { provider: string; id: string; api: string };
  usage: TokenUsage;
}

/**
 * Pi ships a model catalog with per-model adaptation (API protocol, reasoning,
 * context limits and `compat` such as thinking format, developer role or store
 * support). A BYOK profile carries our own provider id, so a normal
 * `getModel(provider, id)` lookup misses and the old code registered a bare
 * entry with no `compat` at all — silently discarding every adaptation Pi has
 * for that model. Resolve by model id across the catalog instead, and when an id
 * appears under several providers prefer the entry with the most specific
 * adaptation rather than an arbitrary one.
 */
function catalogModelFor(runtime: ModelRuntime, modelId: string, baseUrl: string) {
  const host = (value: string | undefined) => {
    try { return new URL(value ?? "").host; } catch { return ""; }
  };
  const endpoint = host(baseUrl);
  const candidates = runtime.getModels().filter((candidate) =>
    candidate.id === modelId && endpoint !== "" && host(candidate.baseUrl) === endpoint);
  if (!candidates.length) return undefined;
  const specificity = (candidate: (typeof candidates)[number]) => Object.keys(candidate.compat ?? {}).length;
  return candidates.reduce((best, candidate) => specificity(candidate) > specificity(best) ? candidate : best);
}

/**
 * The catalog the settings page offers, mirroring how Pi itself lets a user
 * choose a provider and model. Only providers that accept an API key are listed:
 * an OAuth-only provider cannot be configured with a pasted key, so offering it
 * would promise a capability this product does not have. Every entry carries the
 * protocol, default endpoint and limits Pi would use, so the user only supplies
 * a key (and may override the endpoint).
 */
export const SUPPORTED_MODEL_APIS: ReadonlySet<string> = new Set(["openai-completions", "anthropic-messages"]);

export async function listModelCatalog() {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const providers = runtime.getProviders()
    // `auth` is a record keyed by auth type (`{ apiKey: {...}, oauth: {...} }`).
    .filter((provider) => Object.hasOwn(provider.auth ?? {}, "apiKey"))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? "",
      // Only protocols our runtime can actually drive are offered; listing an
      // unsupported one would promise a configuration that cannot run.
      models: (runtime.getModels(provider.id) ?? [])
        .filter((model) => SUPPORTED_MODEL_APIS.has(model.api))
        .map((model) => ({
          id: model.id,
          name: model.name,
          api: model.api,
          reasoning: model.reasoning ?? false,
          input: model.input ?? ["text"],
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })),
    }))
    .filter((provider) => provider.models.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
  return { providers };
}

/**
 * The model list for a saved credential's endpoint, mirroring how Pi itself
 * offers provider → model choice. A built-in catalog provider returns Pi's own
 * models; a custom endpoint returns its OpenAI-compatible `/models` listing so
 * the workbench can render a real dropdown instead of a free-text box.
 */
export async function listModelsForEndpoint(input: { provider: string; baseUrl: string; apiKey: string; modelId: string }): Promise<{
  source: "catalog" | "endpoint" | "none"; models: Array<{ id: string; name: string }>;
}> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const host = (value: string | undefined) => {
    try { return new URL(value ?? "").host; } catch { return ""; }
  };
  const endpoint = host(input.baseUrl);
  const matched = runtime.getProviders().find((provider) =>
    Object.hasOwn(provider.auth ?? {}, "apiKey") && endpoint !== "" && host(provider.baseUrl) === endpoint);
  const withConfiguredDefault = (models: Array<{ id: string; name: string }>) =>
    models.some((model) => model.id === input.modelId)
      ? models
      : [{ id: input.modelId, name: input.modelId }, ...models];
  if (matched) {
    return {
      source: "catalog",
      models: withConfiguredDefault((runtime.getModels(matched.id) ?? [])
        .filter((model) => SUPPORTED_MODEL_APIS.has(model.api))
        .map((model) => ({ id: model.id, name: model.name }))),
    };
  }
  try {
    const url = `${input.baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { source: "endpoint", models: [] };
    const body: unknown = await response.json();
    const entries = body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: Array<{ id?: unknown; name?: unknown }> }).data
      : body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: Array<{ id?: unknown; name?: unknown }> }).models
        : [];
    return {
      source: "endpoint",
      models: withConfiguredDefault(entries.map((model) => ({ id: String(model.id ?? ""), name: String(model.name ?? model.id ?? "") })).filter((model) => model.id)),
    };
  } catch {
    return { source: "endpoint", models: withConfiguredDefault([]) };
  }
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
    // A model id can exist under several providers with different adaptation; only
    // an entry whose endpoint matches the configured one may contribute, exactly
    // as Pi would when the user selects that provider.
    const catalog = config.baseUrl ? catalogModelFor(runtime, config.id, config.baseUrl) : undefined;
    const api: Api =
      config.api ??
      catalog?.api ??
      model?.api ??
      (config.provider === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-completions");
    runtime.registerProvider(config.provider, {
      baseUrl: config.baseUrl,
      api,
      models: [
        {
          // Inherit the catalog's protocol-level adaptation for this exact model
          // id; only identity, endpoint and our own limits are overridden.
          id: config.id,
          name: config.id,
          api,
          reasoning: catalog?.reasoning ?? false,
          ...(catalog?.compat ? { compat: catalog.compat } : {}),
          input: config.supportsImages ? ["text", "image"] : (catalog?.input ?? ["text"]),
          // Prices from another provider's catalog would be a false cost figure.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: config.contextWindow ?? catalog?.contextWindow ?? 128000,
          maxTokens: config.maxTokens ?? Math.min(catalog?.maxTokens ?? 8192, 8192),
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
  const requestedToolBudget = input.maxToolCalls ?? 64;
  if (!Number.isFinite(requestedToolBudget) || requestedToolBudget < 1)
    throw new RuntimeError("TOOL_BUDGET_EXCEEDED", "本次任务工具调用预算已耗尽");
  const maxToolCalls = Math.min(Math.floor(requestedToolBudget), 80);
  const tokens = createRoleTokenTracker(input.tokenBudget);
  let tokenFailure: RuntimeError | undefined;
  const sensitiveValues = [input.modelConfig.apiKey, ...(input.redactValues ?? [])].filter(Boolean);
  const safeDetail = (value: unknown) =>
    sensitiveValues.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), String(value ?? "unknown"))
      .replace(/Bearer\s+[^\s\"']+/gi, "Bearer [REDACTED]")
      .slice(0, 800);
  const isolated = await mkdtemp(join(tmpdir(), "pivloom-pi-"));
  const eventAbort = new AbortController();
  const signal = AbortSignal.any([input.signal, eventAbort.signal]);
  let eventTail = Promise.resolve(), eventFailure = false;
  const eventError = () => new RuntimeError("EVENT_APPEND_FAILED", "运行事件保存失败，已停止模型执行");
  const emit = (event: ProbeEvent) => {
    const operation = eventTail.then(async () => {
      if (eventFailure) throw eventError();
      if (signal.aborted && event.type === "tool.output") return;
      try { await input.onEvent?.(event); }
      catch { eventFailure = true; eventAbort.abort(); throw eventError(); }
    });
    eventTail = operation.catch(() => {});
    return operation;
  };
  const output = createToolOutput(emit, signal, sensitiveValues);
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
              output.append(chunk);
              const clipped = chunk.slice(0, Math.max(0, 16000 - forwarded));
              forwarded += clipped.length;
              if (clipped) options.onData(Buffer.from(clipped));
            },
          });
          const result = await handle.wait();
          if (forwarded === 0) {
            output.append(result.stdoutTail + "\n" + result.stderrTail);
            options.onData(
              Buffer.from(
                (result.stdoutTail + "\n" + result.stderrTail).slice(-16000),
              ),
            );
          }
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
      if (calls.length >= maxToolCalls)
        throw new RuntimeError(
          "TOOL_BUDGET_EXCEEDED",
          "本次任务工具调用已达上限",
        );
      const call = { id, name: definition.name, success: false };
      const publicCallId = /^[\w.:-]{1,128}$/.test(id) && !sensitiveValues.some((secret) => id.includes(secret))
        ? id : `tool-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
      call.id = publicCallId;
      calls.push(call);
      await emit({
        id: randomUUID(),
        at: new Date().toISOString(),
        type: "tool.start",
        toolCallId: publicCallId,
        toolName: definition.name,
        message: `执行远程 ${definition.name}`,
      });
      output.start({ toolCallId: publicCallId, toolName: definition.name });
      try {
        const result = await definition.execute(
          id,
          params,
          toolSignal,
          onUpdate,
          context,
        );
        call.success = true;
        if (definition.name !== "bash") {
          const path = params && typeof params === "object" && "path" in params && typeof params.path === "string" ? safeDetail(params.path) : "指定文件";
          const action = { read: "已读取", write: "已写入", edit: "已修改" }[definition.name] ?? "已处理";
          output.append(`${action} ${path}；源码与编辑内容不写入运行日志。`);
        }
        return result;
      } finally {
        await output.finish();
        await emit({
          id: randomUUID(),
          at: new Date().toISOString(),
          type: "tool.end",
          toolCallId: publicCallId,
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
      compaction: piCompactionSettings(model.contextWindow),
      retry: providerRetrySettings(),
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
      systemPrompt: [
        "You build a React/TypeScript/Vite application. All read/write/edit/bash tools operate ONLY in an isolated remote source workspace. Use relative source paths.",
        "The remote working directory is /workspace/app. Any host temporary cwd shown by the agent harness is session bookkeeping and does not exist in the sandbox. Do not cd to it or explore parent directories. The supplied template already contains package.json, index.html, tsconfig.json, src/main.tsx, src/App.tsx and src/style.css. Read the relevant source files directly; dependencies are already supplied by the service.",
        "Implement a cohesive working application using the existing App entry and stylesheet. Keep small types, validation, persistence and state helpers with the component that owns them; add another source module only for substantial independent behavior. Complete all requested behavior before additional styling or metadata changes.",
        "The served Preview uses Content-Security-Policy script-src 'self' without unsafe-eval. Do not use eval, new Function, or string-based timers to execute generated expressions or code; they fail at runtime even when TypeScript and Vite build pass. Implement requested calculations with normal parsing functions and verify the actual UI flow.",
        "If the request includes user-facing decimal arithmetic, do not display raw binary floating-point tails. Use a general precision strategy that preserves meaningful decimal input and results; never hard-code specific example answers.",
        "Each response may include up to THREE independent small tool calls, executed sequentially by the service. Batch independent reads or writes when their inputs are already known, then wait for results before dependent work. Keep the combined argument text across the entire response below roughly 4,000 characters; never stream several large files at once. This reduces repeated context within the shared run token budget without omitting any requirement.",
        "For a larger file, first write a small complete skeleton, then add one bounded section per edit. Read existing files before editing them. Do not use bash, heredocs or encoded payloads to bypass these bounded writes. Keep explanations short so each response can finish within the model request deadline.",
        "Never seek credentials, host files, services, external accounts or instructions outside the supplied task. Do not alter the build to skip checks. Do not run background processes; the service builds and starts preview. Use the supplied tool results honestly. Finish only after implementing the requested behavior.",
      ].join("\n"),
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
      sessionManager: SessionManager.inMemory(isolated, {
        id: input.sessionId,
      }),
      settingsManager: settings,
      thinkingLevel: "off",
    }));
    // A per-run HTTP transport preserves the caller's DNS-pinned BYOK transport.
    session.agent.streamFunction = (selected, context, options) => {
      requestNumber++;
      requestStartedAt = Date.now();
      responseStatus = undefined;
      streamedCharacters = 0;
      const maxTokens = Math.min(input.modelConfig.maxTokens ?? 4096, 4096);
      try { return tokens.stream(maxTokens, input.modelConfig.fetch, (modelFetch) => runtime.streamSimple(selected, context, {
        ...options,
        fetch: modelFetch,
        transport: "sse",
        timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        maxTokens,
        onResponse: async (response) => {
          responseStatus = response.status;
          await emit({
            id: randomUUID(),
            at: new Date().toISOString(),
            type: "stage",
            stage: "generating",
            message: `模型第 ${requestNumber} 轮响应 HTTP ${response.status}（${Date.now() - requestStartedAt}ms）`,
          });
        },
      })); } catch (error) {
        if (error instanceof RuntimeError) tokenFailure = error;
        throw error;
      }
    };
    session.agent.subscribe((event) => {
      if (event.type === "tool_execution_start") tokens.recordToolCall();
      if (
        event.type === "message_update" &&
        "delta" in event.assistantMessageEvent &&
        typeof event.assistantMessageEvent.delta === "string"
      ) {
        const delta = event.assistantMessageEvent.delta;
        if (delta.length && streamedCharacters === 0)
          void Promise.resolve(
            emit({
              id: randomUUID(),
              at: new Date().toISOString(),
              type: "model.stream.started",
              success: true,
              stage: "generating",
              requestNumber,
              message: `模型第 ${requestNumber} 轮已收到实际流式内容`,
            }),
          ).catch(() => {});
        streamedCharacters += delta.length;
      }
    });
    session.subscribe((event) => {
      if (event.type !== "auto_retry_start" || signal.aborted) return;
      void emit({
        id: randomUUID(),
        at: new Date().toISOString(),
        type: "model.stream.started",
        success: false,
        stage: "generating",
        requestNumber,
        message: `模型第 ${requestNumber} 轮第 ${event.attempt}/${event.maxAttempts} 次瞬态失败，${event.delayMs}ms 后重试`,
      }).catch(() => {});
    });
    session.agent.shouldStopAfterTurn = () => calls.length >= maxToolCalls;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      throw new RuntimeError("CANCELLED", "模型任务已取消");
    }
    await session.prompt(input.prompt);
    await eventTail;
    if (tokens.failure) throw tokens.failure;
    if (tokenFailure) throw tokenFailure;
    if (eventFailure) throw eventError();
    if (signal.aborted)
      throw new RuntimeError(
        input.signal.reason === "RUN_TIMEOUT" ? "RUN_TIMEOUT" : "CANCELLED",
        "模型任务已停止",
      );
    if (calls.length >= maxToolCalls)
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
    return {
      text,
      toolCalls: calls,
      model: { provider: model.provider, id: model.id, api: model.api },
      usage: tokens.usage(),
    };
  } catch (error) {
    const failure = tokens.failure ?? tokenFailure ?? (eventFailure ? eventError()
      : error instanceof RuntimeError ? error
        : signal.aborted ? new RuntimeError(input.signal.reason === "RUN_TIMEOUT" ? "RUN_TIMEOUT" : "CANCELLED", "模型任务已停止")
          : new RuntimeError("MODEL_FAILED", `模型执行失败：${safeDetail(error instanceof Error ? error.message : error)}`));
    throw new RuntimeError(failure.code, failure.message, failure.trustedBuild, tokens.usage());
  } finally {
    output.dispose();
    signal.removeEventListener("abort", abort);
    if (aborting) {
      // Pi's abort() waits for the agent to become idle. A five-second race
      // reported an unconfirmed stop and disposed the session while its model
      // or remote tool could still be running.
      const stopped = await aborting.then(() => true, () => false);
      if (!eventFailure) await emit({
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
    await session?.waitForIdle();
    await eventTail;
    session?.dispose();
    await rm(isolated, { recursive: true, force: true });
  }
}
