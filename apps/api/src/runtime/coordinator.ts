import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { TSchema } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  GroupedPlanSchema, PlanningContextSchema, ClarificationRequestSchema, preservesPreviousBehavior,
  type Plan, type PlanningContext,
} from "@pivloom/contracts";
import { createServiceModel } from "./pi.js";
import { RuntimeError, type ModelConfig, type ProbeEvent, type ProbeEventSink } from "./types.js";
import { createRoleTokenTracker, type RunTokenBudget, type TokenUsage } from "./token-budget.js";
import { MODEL_REQUEST_TIMEOUT_MS, piCompactionSettings, providerRetrySettings } from "./budgets.js";

export type CoordinatorDecision = { kind: "plan"; plan: Plan } | { kind: "clarification"; question: string };
export interface CoordinatorMetadata {
  usage: TokenUsage;
  toolCalls: Array<{ id: string; name: string; success: boolean }>;
  sessionId: string;
}
export interface CoordinatorInput {
  runId: string;
  roleRunId: string;
  sessionId: string;
  attempt: number;
  baseRevisionId: string | null;
  modelConfig: ModelConfig;
  signal: AbortSignal;
  context: PlanningContext;
  onEvent?: ProbeEventSink;
  assertActive(): Promise<void>;
  onDecision(decision: CoordinatorDecision, metadata: CoordinatorMetadata): Promise<void>;
  maxToolCalls?: number;
  tokenBudget?: RunTokenBudget;
}

const names = ["project_summary", "submit_plan", "request_clarification"] as const;
const planInput = z.strictObject({ plan: GroupedPlanSchema });
const questionInput = ClarificationRequestSchema;
const providerSchemas = new Map<string, TSchema>([
  ["project_summary", z.toJSONSchema(z.strictObject({})) as TSchema],
  ["submit_plan", z.toJSONSchema(planInput) as TSchema],
  ["request_clarification", z.toJSONSchema(questionInput) as TSchema],
]);
const schemaFields = new Set(["plan", "question", "schemaVersion", "goal", "changeSummary", "assumptions", "outOfScope", "behaviors", "groups", "behaviorIds", "replacements", "oldBehaviorId", "newBehaviorId", "userRequestQuote", "reason", "id", "title", "precondition", "action", "expected", "required",
  // Executable verification fields. They belong in the whitelist for the same
  // reason as the prose ones: a rejected step must be named in the correction,
  // otherwise the Coordinator cannot tell which field to fix.
  "steps", "type", "path", "width", "height", "role", "name", "text", "value", "key", "ms",
  "assertions", "kind", "negated", "evidence"]);
function schemaIssues(issues: readonly { path: readonly PropertyKey[]; code: string }[]) {
  return issues.slice(0, 4).map((issue) => {
    const path = issue.path.slice(0, 5).map((part) => typeof part === "number" ? "[]" : typeof part === "string" && schemaFields.has(part) ? part : "[field]").join(".") || "input";
    return `${path}:${issue.code}`;
  }).join(", ").slice(0, 320);
}
const toolResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/**
 * Providers hand tool arguments over in several shapes for the same intent.
 * Measured with the configured Ark endpoint: one model sends `{plan:{...}}`,
 * another flattens the plan fields to the top level, and a third sends the plan
 * as a JSON string or wrapped in an `input`/`arguments` object. All of them are
 * the same decision, so they are normalized here instead of burning the single
 * correction turn on a difference the user cannot see or act on.
 */
export function normalizePlanArguments(params: unknown): unknown {
  const unwrap = (value: unknown): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    for (const wrapper of ["input", "arguments", "parameters", "args"]) {
      const inner = record[wrapper];
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner) && !("plan" in record)) return unwrap(inner);
    }
    return record;
  };
  const parsedJson = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value) as unknown; } catch { return value; }
  };
  const record = unwrap(params);
  if (record === null || typeof record !== "object" || Array.isArray(record)) return params;
  const candidate = record as Record<string, unknown>;
  const plan = parsedJson(candidate.plan);
  if (plan !== null && typeof plan === "object" && !Array.isArray(plan))
    return { ...candidate, plan: { ...(plan as Record<string, unknown>), schemaVersion: 2 } };
  // No usable `plan` key: the model flattened the plan into the tool arguments,
  // so the whole object is the plan (plus a service-owned schemaVersion).
  if (!("plan" in candidate) || candidate.plan === null || candidate.plan === undefined)
    return { plan: { ...candidate, schemaVersion: 2 } };
  return { ...candidate, plan };
}

/** An isolated, read-only planning role. No Workspace or sandbox is available. */
export async function runCoordinator(input: CoordinatorInput): Promise<CoordinatorMetadata & { decision: CoordinatorDecision }> {
  const context = PlanningContextSchema.safeParse(input.context);
  if (!context.success || input.baseRevisionId !== context.data.baseRevisionId || !Number.isInteger(input.attempt) || input.attempt < 0 || input.attempt > 2)
    throw new RuntimeError("COORDINATOR_CONTEXT_INVALID", "协调者需求上下文或版本不匹配");
  if (!input.modelConfig.fetch) throw new RuntimeError("MODEL_CONFIGURATION_MISSING", "协调者需要已验证的模型传输配置");
  const requestedToolBudget = input.maxToolCalls ?? 12;
  if (!Number.isFinite(requestedToolBudget) || requestedToolBudget < 1)
    throw new RuntimeError("TOOL_BUDGET_EXCEEDED", "本次任务工具调用预算已耗尽");
  const maxToolCalls = Math.min(Math.floor(requestedToolBudget), 80);
  const failureAbort = new AbortController();
  const signal = AbortSignal.any([input.signal, failureAbort.signal]);
  let isolated: string | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let aborting: Promise<void> | undefined;
  let fatal: RuntimeError | undefined;
  let eventTail = Promise.resolve();
  let decision: CoordinatorDecision | undefined;
  let requestNumber = 0, receivedStream = false, invalidDecisions = 0;
  const calls: CoordinatorMetadata["toolCalls"] = [];
  const executedCalls = new Set<string>();
  const callArguments = new Map<string, unknown>();
  const tokens = createRoleTokenTracker(input.tokenBudget);
  /** Provider detail is redacted and clipped before it reaches any log or API reply. */
  const safeDetail = (value: unknown) => String(value ?? "unknown")
    .replaceAll(input.modelConfig.apiKey, "[REDACTED]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .slice(0, 400);
  const fail = (error: RuntimeError) => { fatal ??= error; failureAbort.abort(); return error; };
  const invalid = (reason?: string) => {
    invalidDecisions++;
    const error = new RuntimeError("AGENT_OUTPUT_INVALID", invalidDecisions === 1
      ? `方案格式无效。仅允许纠正一次：请按工具说明提交合法计划或单个问题，不要包含凭据。${reason ? ` 校验路径：${reason}` : ""}`
      : "协调者纠正后仍未提交有效方案");
    return invalidDecisions >= 2 ? fail(error) : error;
  };
  const checkSignal = () => {
    if (tokens.failure) throw tokens.failure;
    if (fatal) throw fatal;
    if (signal.aborted) throw new RuntimeError(
      input.signal.reason === "RUN_TIMEOUT" ? "RUN_TIMEOUT" : "CANCELLED",
      "协调者执行已停止",
    );
  };
  const active = async () => {
    checkSignal();
    try { await input.assertActive(); }
    catch { checkSignal(); throw fail(new RuntimeError("ROLE_NOT_ACTIVE", "当前协调者角色或任务已失效")); }
    checkSignal();
  };
  const publicId = (id: string) => /^[\w.:-]{1,128}$/.test(id) && !id.includes(input.modelConfig.apiKey)
    ? id : `tool-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
  const emit = (event: Omit<ProbeEvent, "id" | "at" | "roleRunId" | "sessionId"> | Array<Omit<ProbeEvent, "id" | "at" | "roleRunId" | "sessionId">>, afterFatal = false) => {
    const operation = eventTail.then(async () => {
      if (fatal && !afterFatal) throw fatal;
      try { for (const item of Array.isArray(event) ? event : [event])
        await input.onEvent?.({ ...item, id: randomUUID(), at: new Date().toISOString(), roleRunId: input.roleRunId, sessionId: input.sessionId }); }
      catch { throw fail(new RuntimeError("EVENT_APPEND_FAILED", "协调者事件保存失败，已停止执行")); }
    });
    eventTail = operation.catch(() => {});
    return operation;
  };
  const metadata = (): CoordinatorMetadata => {
    return { sessionId: input.sessionId, toolCalls: calls.map((call) => ({ ...call })),
      usage: tokens.usage() };
  };
  const abort = () => { aborting ??= session?.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await active();
    isolated = await mkdtemp(join(tmpdir(), "pivloom-coordinator-"));
    const { runtime, model } = await createServiceModel(input.modelConfig, signal);
    const settings = SettingsManager.inMemory({ compaction: piCompactionSettings(model.contextWindow), retry: providerRetrySettings(), cacheWarming: "off", defaultProjectTrust: "never" });
    const loader = new DefaultResourceLoader({
      cwd: isolated, agentDir: isolated, settingsManager: settings, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: [
        "You are the Coordinator for a frontend React application builder. You only have project_summary, submit_plan and request_clarification. You cannot read host files, execute commands, write source, create sandboxes, delegate roles or change service state.",
        "Use the supplied project summary to preserve the original request and clarification answers. Submit schemaVersion 2 with exactly five stable groups G1–G5, each named for this app and containing at least one required atomic behavior. Every child behavior must belong to exactly one group; five groups do not mean only five requirements.",
        "Use the five groups as distinct application-specific facets in this order: G1 primary outcome, G2 input and control, G3 edge cases or progression, G4 result and state, G5 visual layout or restart and persistence. Give each group a title that describes the actual app. Do not use a group only to inventory visible buttons when the request asks what those buttons must do.",
        "On an increment preserve EVERY previous required behavior's ID, precondition, action, expected result and required flag, in the same group. Keep all five group names and IDs stable. Carry all prior replacement records unchanged so retired IDs stay retired. Add new behaviors with new IDs. Never reuse an old ID for a changed meaning. Only when the user's current request explicitly changes an old behavior may you record a replacement: oldBehaviorId, newBehaviorId, a verbatim userRequestQuote expressing the change, and reason; keep the replacement in the old group. Do not silently omit a prior requirement.",
        "Reviewer starts in a fresh isolated browser and can navigate/reload the bound app, fill/select/click/press controls and inspect DOM/source. Write acceptance steps using those capabilities: verify initial empty state before adding records, and persistence by reloading. Do not require developer tools, manually clearing storage, editing DOM or backend access as test steps. Use the smallest dataset that distinguishes the requested behavior; do not invent extra business requirements.",
        "Each behavior target must include a meaningful interaction from the requested workflow and an observed result. Combine static initial-state assertions with the first actual business flow, such as requested form validation, instead of a standalone open-and-look target. Preserve every explicit requirement, including the initial empty state; do not add arbitrary clicks or new functionality just to produce action evidence.",
        "Before submit_plan, compare every explicit clause of requestText and originalRequest against the required targets. If the user named an operation, example expression, numeric form, keyboard shortcut, error-and-recovery path, saved state, color, or viewport width, include an action and expected observation that actually tests it. A control merely existing, a generic 'works' assertion, or a different viewport does not cover the named requirement. Fill any missing clause before submitting.",
        "Keep the plan executable by one independent Reviewer: combine closely related keys or buttons into one short reproducible behavior sequence with all requested outcomes stated explicitly, instead of making every key and button a separate target. Do not combine unrelated requirements or hide any requested outcome inside a vague title; the child checks must still make omissions visible.",
        "Make each verified behavior replayable without a model: steps is an ordered list of { type, ... } operations — open(path), reload, resize(width,height), click/fill/select(name,role,...), press(key), wait(ms) and capture as a screenshot marker. Locate every control by accessible role and name from the accessibility tree, never by CSS selector, coordinates or DOM path, and use only operations the Reviewer's browser already has.",
        "assertions are script-decidable checks over the accessibility tree, page text or console: { kind: text|control|console-error, text?, name?, role?, negated? }. Assert only what those observations prove without a model or a judgement call, and reserve evidence: \"visual\" for a result that genuinely cannot be judged from text — colour, alignment, overflow or canvas drawing.",
        "steps, assertions and evidence are optional; a behavior without them stays prose-only and the five-group completeness rules still apply to it. Compiling or refining them on a preserved behavior is not a change of meaning and needs no replacement record, but its precondition, action, expected and required must still be preserved exactly.",
        "Every explicitly requested observable behavior MUST have required: true. Use required: false only for unrequested refinements. Never downgrade explicitly requested persistence or saving results to an optional behavior.",
        "Use reasonable defaults for reversible choices such as colors and layout. Ask one concise, essential business question only when implementation would otherwise guess important meaning. Do not ask again about information already supplied.",
        "Ask ONLY ONE essential question that blocks the core behavior. Use a single line of at most 300 characters with at most one question mark, only at the end. No checklist, numbered list, compound questions, or options about optional history, export, rounding or layout. Use reasonable defaults for such secondary details. Never assume a missing business formula: ask only for that formula when it is the blocker.",
        "This product generates a frontend demonstration. Explain real payments, cross-user backend data and other unsupported capabilities in outOfScope; never promise actual payment or backend execution. Prefer an honest, useful frontend plan when feasible.",
        "Submit exactly one structured decision using submit_plan or request_clarification. A tool acceptance only means the proposal awaits service confirmation. Do not claim persistence or successful handoff yourself. Do not reveal private reasoning or credentials. Keep responses concise; use one tool call per response.",
      ].join("\n"),
    });
    await loader.reload();
    const tools: ToolDefinition[] = names.map((name) => ({
      name, label: name, executionMode: "sequential",
      description: name === "project_summary" ? "Read the service-supplied project request, clarification history and previous plan."
        : name === "submit_plan" ? "Submit one schemaVersion 2 plan with five groups and every atomic behavior; preserve every previous required ID and meaning, or record an explicit user-requested replacement."
          : "Submit {question: string}: exactly ONE essential blocking question, one line, at most 300 characters. No checklist or questions about optional features; at most one question mark at the end.",
      parameters: providerSchemas.get(name)!,
      prepareArguments: (params) => name === "submit_plan" ? normalizePlanArguments(params)
        : params !== null && typeof params === "object" && !Array.isArray(params) ? params : { invalidInput: true },
      execute: async (id, params) => {
        executedCalls.add(publicId(id));
        if (decision) throw new RuntimeError("HANDOFF_ALREADY_SUBMITTED", "本轮已接收一个方案，不能重复提交或继续调用工具");
        await active();
        await emit({ type: "tool.start", toolName: name, toolCallId: publicId(id), message: `协调者执行 ${name}` });
        let success = false;
        const reject = async (reason: string) => {
          await emit({ type: "tool.output", toolName: name, toolCallId: publicId(id), message: `参数校验未通过（第 ${invalidDecisions + 1} 次）：${reason}` });
          return invalid(reason);
        };
        try {
          let result;
          if (name === "project_summary") result = toolResult(JSON.stringify(context.data).replaceAll(input.modelConfig.apiKey, "[REDACTED]"));
          else {
            // `schemaVersion` is service bookkeeping, not a decision the model
            // owns. Forcing it here stops a malformed literal from burning the
            // single correction turn and the extra model requests it costs.
            const normalized = name === "submit_plan" ? normalizePlanArguments(params) : params;
            const parsed = name === "submit_plan" ? planInput.safeParse(normalized) : questionInput.safeParse(params);
            if (!parsed.success) throw await reject(schemaIssues(parsed.error.issues));
            if (JSON.stringify(parsed.data).includes(input.modelConfig.apiKey)) throw await reject("input:protected_value");
            if ("plan" in parsed.data && !preservesPreviousBehavior(parsed.data.plan, context.data.previousPlan, context.data.requestText)) {
              const requiredIds = context.data.previousPlan?.behaviors.filter((behavior) => behavior.required).map((behavior) => behavior.id) ?? [];
              throw await reject(`plan.behaviors:previous_behavior_required——必须保留全部旧必需 ID 与可观察语义，或引用用户本轮明确变更作新 ID 替代。旧必需 ID：${requiredIds.join(",").slice(0, 180)}`);
            }
            decision = "plan" in parsed.data ? { kind: "plan", plan: parsed.data.plan } : { kind: "clarification", question: parsed.data.question };
            result = toolResult("方案已接收，等待服务端确认；尚未持久化或交接。");
          }
          await active();
          success = true;
          return result;
        } finally {
          if (!fatal) await emit({ type: "tool.end", toolName: name, toolCallId: publicId(id), success, message: success ? "协调者工具已返回，等待服务端处理" : "协调者工具未完成" });
        }
      },
    }));
    ({ session } = await createAgentSession({
      cwd: isolated, agentDir: isolated, modelRuntime: runtime, model,
      noTools: "builtin", tools: [...names], customTools: tools, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(isolated, { id: input.sessionId }), settingsManager: settings, thinkingLevel: "off",
    }));
    session.agent.toolExecution = "sequential";
    session.agent.streamFunction = (selected, messageContext, options) => {
      checkSignal(); requestNumber++; receivedStream = false;
      const maxTokens = Math.min(input.modelConfig.maxTokens ?? 4096, 4096);
      try {
        return tokens.stream(maxTokens, input.modelConfig.fetch, (modelFetch) => runtime.streamSimple(selected, messageContext, { ...options, fetch: modelFetch, transport: "sse",
          timeoutMs: MODEL_REQUEST_TIMEOUT_MS, maxRetries: 0, maxTokens }));
      } catch (error) {
        if (error instanceof RuntimeError) throw fail(error);
        throw error;
      }
    };
    session.agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        tokens.recordToolCall();
        if (calls.length >= maxToolCalls) { fail(new RuntimeError("TOOL_BUDGET_EXCEEDED", "协调者工具调用预算耗尽")); return; }
        const name = [...names, "read", "write", "edit", "bash"].includes(event.toolName) ? event.toolName : "unauthorized_tool";
        calls.push({ id: publicId(event.toolCallId), name, success: false });
        callArguments.set(publicId(event.toolCallId), event.args);
      } else if (event.type === "tool_execution_end") {
        const call = [...calls].reverse().find((item) => item.id === publicId(event.toolCallId));
        if (call) call.success = !event.isError;
        // Pi validates the single ToolDefinition before execute. Count those
        // immediate errors in the same one-correction budget as domain errors;
        // otherwise a model can submit malformed calls indefinitely.
        const callId = publicId(event.toolCallId);
        if (event.isError && call && !executedCalls.has(callId) && names.includes(call.name as typeof names[number])) {
          const argument = callArguments.get(callId);
          const parsed = call.name === "submit_plan" ? planInput.safeParse(normalizePlanArguments(argument))
            : call.name === "request_clarification" ? questionInput.safeParse(argument)
              : z.strictObject({}).safeParse(argument);
          const reason = parsed.success ? "input:invalid_arguments" : schemaIssues(parsed.error.issues);
          void emit([
            { type: "tool.start", toolName: call.name, toolCallId: callId, message: `协调者执行 ${call.name}` },
            { type: "tool.output", toolName: call.name, toolCallId: callId,
              message: `参数校验未通过（第 ${invalidDecisions + 1} 次）：${reason}` },
          ], true).catch(() => {});
          invalid(reason);
        }
        executedCalls.delete(callId);
        callArguments.delete(callId);
      } else if (event.type === "message_update" && "delta" in event.assistantMessageEvent && typeof event.assistantMessageEvent.delta === "string" && event.assistantMessageEvent.delta && !receivedStream) {
        receivedStream = true;
        void emit({ type: "model.stream.started", requestNumber, success: true, message: "协调者已收到实际模型响应" }).catch(() => {});
      }
    });
    session.subscribe((event) => {
      if (event.type !== "auto_retry_start" || signal.aborted) return;
      void emit({ type: "model.stream.started", requestNumber, success: false,
        message: `协调者请求第 ${event.attempt}/${event.maxAttempts} 次瞬态失败，${event.delayMs}ms 后重试` }).catch(() => {});
    });
    session.agent.shouldStopAfterTurn = () => Boolean(decision) || calls.length >= maxToolCalls;
    checkSignal();
    await session.prompt("请读取 project_summary，整理这个项目的需求，然后提交计划或提出一个关键澄清问题。");
    await eventTail; checkSignal();
    const checkModelResult = () => {
      const last = [...session!.messages].reverse().find((message) => message.role === "assistant");
      if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"))
        throw new RuntimeError(/timeout|timed out|abort/i.test(last.errorMessage ?? "") ? "MODEL_REQUEST_TIMEOUT" : "MODEL_FAILED",
          // The provider's own message is the only way to tell a rejected request
          // from a transient outage; it is redacted and clipped like every other
          // provider detail this role reports.
          `协调者模型请求未完成，请检查配置或稍后重试；${safeDetail(last.errorMessage)}`);
    };
    checkModelResult();
    if (!decision && calls.length < maxToolCalls && invalidDecisions === 0) {
      invalidDecisions++;
      await active();
      await session.prompt("尚未收到结构化方案。这是唯一的纠正机会：请调用 submit_plan 或 request_clarification，普通文字不构成交接。");
      await eventTail; checkSignal(); checkModelResult();
    }
    if (!decision) throw new RuntimeError(calls.length >= maxToolCalls ? "TOOL_BUDGET_EXCEEDED" : "AGENT_OUTPUT_INVALID", "协调者未提交有效方案");
    // Flush all tool events before the transaction ends this role/run. The
    // service callback rechecks role/attempt and persists the decision once.
    await active();
    const result = metadata();
    await input.onDecision(decision, result);
    checkSignal();
    return { ...result, decision };
  } catch (error) {
    try { checkSignal(); } catch (stopped) { error = stopped; }
    const failure = error instanceof RuntimeError ? error : new RuntimeError("COORDINATOR_FAILED", "协调者执行或交接未完成，请稍后重试");
    throw new RuntimeError(failure.code, failure.message, failure.trustedBuild, tokens.usage());
  } finally {
    signal.removeEventListener("abort", abort);
    if (aborting) await aborting.catch(() => {});
    await session?.waitForIdle();
    await eventTail;
    session?.dispose();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
}
