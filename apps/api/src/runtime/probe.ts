import { randomUUID } from "node:crypto";
import {
  SandboxApiException,
  SandboxManager,
} from "@alibaba-group/opensandbox";
import { OpenSandboxWorkspace, sandboxConnectionConfig } from "./workspace.js";
import { runBuilder } from "./pi.js";
import {
  initializeReactWorkspace,
  buildAndPreview,
  sourceHash,
} from "./generation.js";
import { RemoteBrowser } from "./browser.js";
import { SOURCE_SCHEMA_VERSION, REACT_TEMPLATE_VERSION } from "./snapshot.js";
import {
  RuntimeError,
  type RunProbeInput,
  type ProbeResult,
  type ProbeEvent,
  type WorkspaceHandle,
  type SandboxConfig,
} from "./types.js";

export const DEFAULT_PROBE_PROMPT =
  "做一个中文记录管理小应用，有标签为“记录”的必填文本框、名称为“添加”的提交按钮和初始为空的记录列表。提交后显示原输入文本并清空文本框，使用 localStorage 保存，手机宽度可用。不要请求外部 API。";
export async function runProbe(input: RunProbeInput): Promise<ProbeResult> {
  const started = Date.now(),
    runId = randomUUID(),
    revisionId = randomUUID();
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), 600000);
  const result: ProbeResult = {
    status: "failed",
    runId,
    events: [],
    evidence: {
      model: {
        provider: input.modelConfig.provider,
        id: input.modelConfig.id,
        api: input.modelConfig.api,
        imageCapability: "dom_only",
      },
      versions: {
        pi: "0.86.1",
        opensandbox: "1.1.0",
        image: input.sandboxConfig.image,
        node: process.version,
        sourceSchemaVersion: String(SOURCE_SCHEMA_VERSION),
        templateVersion: REACT_TEMPLATE_VERSION,
      },
      toolCalls: [],
      checks: [],
      elapsedMs: 0,
    },
    cleanup: { state: "not_created" },
  };
  const emit = async (event: Omit<ProbeEvent, "id" | "at">) => {
    const value = { ...event, id: randomUUID(), at: new Date().toISOString() };
    result.events.push(value);
    await input.onEvent?.(value);
  };
  const sink = async (event: ProbeEvent) => {
    result.events.push(event);
    if (event.type === "tool.end" && event.toolCallId && event.toolName)
      result.evidence.toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        success: event.success === true,
      });
    await input.onEvent?.(event);
  };
  const workspace = new OpenSandboxWorkspace(input.sandboxConfig);
  let handle: WorkspaceHandle | undefined,
    browser: RemoteBrowser | undefined,
    retained = false;
  try {
    await emit({ type: "stage", stage: "creating", message: "创建隔离沙箱" });
    handle = await workspace.create({ runId, signal });
    result.cleanup = { state: "pending", sandboxId: handle.sandboxId };
    await emit({
      type: "resource.created",
      sandboxId: handle.sandboxId,
      message: "沙箱已创建",
    });
    await initializeReactWorkspace(workspace, handle);
    const versions = await workspace.executeService(
      handle,
      "node --version && chromium --version && agent-browser --version",
      { uid: 0 },
    );
    result.evidence.versions.remote = versions.stdoutTail.trim();
    await emit({
      type: "stage",
      stage: "generating",
      message: "Pi 正在使用远程工具实现需求",
    });
    const built = await runBuilder({
      workspace,
      handle,
      modelConfig: input.modelConfig,
      prompt:
        (input.prompt.trim() || DEFAULT_PROBE_PROMPT) +
        "\n这是 G0 真实工具探针：实现总计不超过100行，保留初始模板和样式，不安装依赖。按以下顺序实际调用工具：1.read src/App.tsx；2.write src/App.tsx，用一个小文件实现表单、列表和localStorage；3.edit 精确修改一个标题文案；4.bash 检查文件确实存在。不启动预览服务器。所有文件位于远程源码根目录，使用相对路径。保留标签为“记录”的文本框和名称为“添加”的提交按钮，提交后必须显示输入值，供独立浏览器检验。",
      signal,
      onEvent: sink,
    });
    result.evidence.toolCalls = built.toolCalls;
    result.evidence.model.api = built.model.api;
    for (const name of ["read", "write", "edit", "bash"])
      if (!built.toolCalls.some((call) => call.name === name && call.success))
        throw new RuntimeError(
          "TOOL_PROBE_INCOMPLETE",
          `模型未成功执行 ${name} 工具`,
        );
    result.evidence.checks.push({
      name: "pi-remote-tools",
      status: "PASS",
      detail: "真实模型成功执行远程 read/write/edit/bash",
    });
    await emit({
      type: "stage",
      stage: "building",
      message: "执行固定 TypeScript 与 production build",
    });
    const candidate = await buildAndPreview(workspace, handle, revisionId);
    result.evidence.sources = candidate.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.content.byteLength,
    }));
    result.evidence.checks.push({
      name: "typecheck-production-build-marker",
      status: "PASS",
      detail: "固定入口退出码均为 0，预览 marker 与源码哈希一致",
    });
    const binding = {
      sandboxId: handle.sandboxId,
      url: "",
      revisionId,
      sourceHash: candidate.sourceHash,
      expiresAt: handle.expiresAt,
    };
    if (input.publishPreview)
      binding.url = await input.publishPreview({
        ...binding,
        upstreamUrl: candidate.upstreamUrl,
        headers: candidate.headers,
      });
    result.preview = binding;
    await emit({
      type: "stage",
      stage: "checking",
      message: "独立 Chrome 填写并提交记录",
    });
    browser = new RemoteBrowser(workspace, handle, sink);
    let observed = await browser.open();
    const find = (role: string, name: string) =>
      Object.entries(observed.refs).find(
        ([, ref]) => ref.role === role && ref.name === name,
      )?.[0];
    const textRef = find("textbox", "记录");
    if (!textRef)
      throw new RuntimeError("CHECK_BLOCKED", "未观察到“记录”文本框");
    const sample = "G0 实测记录 " + runId.slice(0, 8);
    observed = await browser.act({
      type: "fill",
      ref: textRef,
      text: sample,
      observationId: observed.id,
    });
    const button = find("button", "添加");
    if (!button) throw new RuntimeError("CHECK_BLOCKED", "未观察到“添加”按钮");
    observed = await browser.act({
      type: "click",
      ref: button,
      observationId: observed.id,
    });
    // The interactive snapshot may omit plain list text; observe full DOM for the outcome.
    const outcome = await fetch(
      candidate.upstreamUrl + "/pivloom-revision.json",
      { headers: candidate.headers, signal: AbortSignal.timeout(5000) },
    );
    if (!outcome.ok)
      throw new RuntimeError("CHECK_BLOCKED", "检查期间预览不可用");
    const full = await browser.text();
    if (!full.includes(sample))
      throw new RuntimeError("CHECK_FAILED", "提交后没有显示刚输入的记录");
    result.evidence.screenshot = await browser.screenshot();
    const logs = await browser.logs();
    if (Array.isArray(logs.errors) && logs.errors.length)
      throw new RuntimeError("CHECK_FAILED", "Chrome 观察到运行异常");
    const closed = await browser.close();
    if (!closed.confirmed)
      throw new RuntimeError("CHECK_BLOCKED", "Chrome 关闭尚未确认");
    if (
      sourceHash(await workspace.listSourceFiles(handle)) !==
      candidate.sourceHash
    )
      throw new RuntimeError(
        "REVISION_CHANGED_DURING_REVIEW",
        "浏览器检查期间源码发生变化",
      );
    signal.throwIfAborted();
    result.evidence.checks.push({
      name: "chrome-fill-submit-observe-screenshot-close",
      status: "PASS",
      detail: "真实 Chrome 填写、提交，独立DOM确认记录，并保存截图和关闭会话",
    });
    result.evidence.checks.push({
      name: "vision-model",
      status: "BLOCKED",
      detail: "此次模型视觉能力未实测；仅 DOM 行为检查",
    });
    await workspace.releaseClient(handle);
    retained = true;
    result.status = "ready";
    result.cleanup = {
      state: "retained_until_expiry",
      sandboxId: handle.sandboxId,
      expiresAt: handle.expiresAt,
    };
    await emit({
      type: "stage",
      stage: "ready",
      message: "G0 生成与浏览器行为检查完成，可在独立预览操作",
    });
  } catch (error) {
    result.status = signal.aborted ? "cancelled" : "failed";
    const code = error instanceof RuntimeError ? error.code : "PROBE_FAILED";
    let message =
      error instanceof RuntimeError
        ? error.message
        : "探针未完成；请检查模型、沙箱或浏览器连接";
    for (const secret of [input.modelConfig.apiKey, input.sandboxConfig.apiKey])
      if (secret) message = message.replaceAll(secret, "[REDACTED]");
    result.error = { code, message };
  } finally {
    clearTimeout(timer);
    if (!retained) {
      if (browser) await browser.close();
      if (handle) {
        const cleanup = await workspace.destroy(handle);
        result.cleanup = {
          state: cleanup.confirmed ? "confirmed" : "pending",
          sandboxId: handle.sandboxId,
        };
        if (!cleanup.confirmed) result.status = "cleanup_pending";
        await emit({
          type: "resource.cleaned",
          sandboxId: handle.sandboxId,
          success: cleanup.confirmed,
          message: cleanup.confirmed ? "候选沙箱已确认销毁" : "沙箱清理待确认",
        });
      } else {
        const pending = workspace
          .resources()
          .find((resource) => resource.state !== "destroyed");
        if (pending) {
          result.status = "cleanup_pending";
          result.cleanup = { state: "pending", sandboxId: pending.sandboxId };
        }
      }
    }
    result.evidence.elapsedMs = Date.now() - started;
  }
  return result;
}
export async function destroyProbePreview(
  config: SandboxConfig,
  sandboxId: string,
): Promise<{ confirmed: boolean }> {
  const manager = SandboxManager.create({
    connectionConfig: sandboxConnectionConfig(config),
  });
  try {
    try {
      await manager.killSandbox(sandboxId);
    } catch (error) {
      if (!(error instanceof SandboxApiException && error.statusCode === 404))
        throw error;
    }
    try {
      await manager.getSandboxInfo(sandboxId);
      return { confirmed: false };
    } catch (e) {
      return {
        confirmed: e instanceof SandboxApiException && e.statusCode === 404,
      };
    }
  } catch (e) {
    return {
      confirmed: e instanceof SandboxApiException && e.statusCode === 404,
    };
  } finally {
    await manager.close();
  }
}
