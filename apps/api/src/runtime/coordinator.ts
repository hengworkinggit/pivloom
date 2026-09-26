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
  BehaviorProgramSchema, GroupedPlanSchema, PlanningContextSchema, ClarificationRequestSchema, preservesPreviousBehavior,
  type GroupedPlan, type Plan, type PlanningContext,
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
  "assertions", "kind", "negated", "evidence", "initialState", "target", "within", "match", "count", "keys", "repeat"]);

/** Omitted inherited fields reuse the sealed program; an explicitly changed field is still rejected. */
function inheritPrograms(plan: GroupedPlan, previous: Plan | null): GroupedPlan {
  const byId = new Map(previous?.behaviors.map(behavior => [behavior.id, behavior]));
  return { ...plan, behaviors: plan.behaviors.map(behavior => {
    const prior = byId.get(behavior.id);
    if (!prior) return behavior;
    return { ...behavior,
      ...(behavior.steps === undefined && prior.steps ? { steps: prior.steps } : {}),
      ...(behavior.assertions === undefined && prior.assertions ? { assertions: prior.assertions } : {}),
      ...(behavior.initialState === undefined && prior.initialState ? { initialState: prior.initialState } : {}),
      ...(behavior.evidence === undefined && prior.evidence ? { evidence: prior.evidence } : {}),
    };
  }) };
}
/**
 * Output floor for the coordinator. Sized from the measured cost of a stepped plan (5,120 tokens for the
 * cheapest possible one) with room for app-specific steps, which are longer than the repeated ones used
 * for that measurement.
 */
const COORDINATOR_OUTPUT_TOKENS = 16_384;

/**
 * Name the increment gap instead of restating the rule.
 *
 * The guard refused a plan and answered with the rule plus the whole list of forty-one ids, which says
 * neither which behaviour is wrong nor what it should have contained, leaving every correction a guess -
 * and measured runs failed this guard on attempt after attempt. This names the offending ids and, for a
 * field that differs, quotes the stored text so the model's job is to copy rather than to search. The
 * guard itself is unchanged: it still refuses exactly what it refused before, and nothing here decides
 * whether a plan is acceptable.
 */
function describeIncrementGap(
  plan: { behaviors: Array<{ id: string; precondition?: unknown; action?: unknown; expected?: unknown; required?: unknown; steps?: unknown; assertions?: unknown; initialState?: unknown; evidence?: unknown }>; groups?: Array<{ id: string; title?: unknown }> },
  previousPlan: { behaviors: Array<{ id: string; precondition?: unknown; action?: unknown; expected?: unknown; required?: unknown; steps?: unknown; assertions?: unknown; initialState?: unknown; evidence?: unknown }>; groups?: Array<{ id: string; title?: unknown }> } | null | undefined,
): string {
  if (!previousPlan) return "计划与上一版不一致，但服务端没有可对照的上一版计划。";
  const present = new Map(plan.behaviors.map((behavior) => [behavior.id, behavior]));
  const missing: string[] = [], changed: string[] = [];
  for (const prior of previousPlan.behaviors) {
    if (!prior.required) continue;
    const now = present.get(prior.id);
    if (!now) { missing.push(prior.id); continue; }
    for (const field of ["precondition", "action", "expected"] as const) {
      if (now[field] !== prior[field]) changed.push(`${prior.id}.${field} 必须逐字为「${String(prior[field]).slice(0, 70)}」`);
    }
    if (Boolean(now.required) !== Boolean(prior.required)) changed.push(`${prior.id}.required 必须为 ${String(prior.required)}`);
    for (const field of ['steps', 'assertions', 'initialState', 'evidence'] as const)
      if (prior[field] !== undefined && JSON.stringify(now[field]) !== JSON.stringify(prior[field]))
        changed.push(`${prior.id}.${field} 必须保留已封存的执行程序；可省略让服务端复用，不能静默改写`);
  }
  const renamed: string[] = [];
  for (const group of previousPlan.groups ?? []) {
    const current = (plan.groups ?? []).find((item) => item.id === group.id);
    if (!current) renamed.push(`${group.id} 分组缺失`);
    else if (current.title !== group.title) renamed.push(`${group.id}.title 必须逐字为「${String(group.title).slice(0, 70)}」`);
  }
  const parts: string[] = [];
  if (missing.length) parts.push(`缺少旧必需行为：${missing.join(",").slice(0, 120)}`);
  if (renamed.length) parts.push(`以下分组与上一版不一致：${renamed.join("；").slice(0, 300)}`);
  if (changed.length) parts.push(`以下字段与上一版不一致：${changed.slice(0, 5).join("；").slice(0, 420)}`);
  return parts.length ? parts.join("。") : "计划与上一版不一致，但具体差异未能定位。";
}

function schemaIssues(issues: readonly { path: readonly PropertyKey[]; code: string; expected?: unknown; received?: unknown }[]) {
  // The correction goes back to the model that produced the arguments, and a bare `field:invalid_type`
  // does not tell it what it sent or what was wanted — a measured run failed twice on `groups` and
  // `required` without ever learning either. Naming the received value and the expected type is the
  // same fix this project already made for run failures and for the maintenance tool.
  return issues.slice(0, 4).map((issue) => {
    const path = issue.path.slice(0, 5).map((part) => typeof part === "number" ? "[]" : typeof part === "string" && schemaFields.has(part) ? part : "[field]").join(".") || "input";
    const expected = typeof issue.expected === "string" ? `expected ${issue.expected}` : "";
    const received = issue.received === undefined ? ""
      : `received ${(typeof issue.received === "string" ? issue.received : typeof issue.received).slice(0, 40)}`;
    const detail = [expected, received].filter(Boolean).join(", ");
    return `${path}:${issue.code}${detail ? ` (${detail})` : ""}`;
  }).join(", ").slice(0, 600);
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
  // Measured: a coordinator rewriting a forty-one behaviour plan fails the first submission and comes
  // visibly closer on the next one, so stopping after a single correction discarded work that was
  // converging. This limits how long the coordinator may keep trying, never what counts as valid: the
  // same guard refuses the same things and the same reason is fed back.
  const COORDINATOR_MAX_ATTEMPTS = 4;
  const invalid = (reason?: string) => {
    invalidDecisions++;
    const error = new RuntimeError("AGENT_OUTPUT_INVALID", invalidDecisions < COORDINATOR_MAX_ATTEMPTS
      ? `方案格式无效。请按工具说明提交合法计划或单个问题，不要包含凭据。${reason ? ` 校验路径：${reason}` : ""}`
      : "协调者多次纠正后仍未提交有效方案");
    return invalidDecisions >= COORDINATOR_MAX_ATTEMPTS ? fail(error) : error;
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
        "Read project_summary to retain the original request and clarification answers. Submit schemaVersion 2 with exactly five groups, literally G1, G2, G3, G4 and G5. Every atomic behavior has an id B01, B02, ... and belongs to exactly one group. Five groups do not mean only five requirements. Never create G6.",
        "Use distinct application-specific facets: G1 primary outcome, G2 input/control, G3 edge cases/progression, G4 result/state, G5 layout/restart/persistence. Name them for this application. On increments preserve all group ids and titles.",
        "On an increment copy every previous required behavior's id, precondition, action, expected and required VERBATIM. Do not merge, drop, renumber or change the meaning of an existing behavior. Preserve prior replacement records. Only an explicit user-requested behavior change permits a replacement with oldBehaviorId, newBehaviorId, a verbatim userRequestQuote expressing that change, and reason, in the same group.",
        "Reuse existing executable programs. You may OMIT inherited steps, assertions, initialState and evidence; the service restores those exact saved fields. If you include them, copy them unchanged. Never invert an assertion, change its target or shorten an existing input sequence to get a pass. Legacy missing fields may be filled without rewriting requirement prose. A defective saved test needs an explicit test correction, not a silent rewrite.",
        "Every new executable behavior needs initialState, steps and assertions. Use initialState: 'fresh' for independent scenarios: it opens a clean isolated application context. Use 'continue' only when a scenario intentionally depends on earlier state. Steps must start with open(path:'/'). Create every precondition through real UI actions in that scenario. reload inside the same scenario preserves its state and tests persistence; do not request a new fresh context between save and reload.",
        "Steps are open, reload, resize(width,height), click/fill/select(role,name,...), press(key), key_sequence(keys,repeat), wait(ms), capture. Use actual accessible role/name contracts that Builder can implement, not guessed CSS, coordinates, arbitrary code or injected app state. A key_sequence dispatches each listed key as a real input; repeat repeats the complete list. Total expanded keys are bounded at 512, regular steps at 64. For a requirement with N distinct submissions list ALL N inputs; never replace the middle with an ellipsis or test only the first and last.",
        "Use typed outcome assertions: target-text {target:{role,name?,within?:{role,name}},text,match:'exact'|'contains',negated}; target-value {target,value,negated}; target-count {target,count,negated}. Locate the expression, result, status, list or row you mean. An empty value is ''. Scope repeated rows with within and count listitem/row targets. Text/value targets must resolve uniquely. Whole-page kind:'text' can only describe legacy page-text facts and must not be used for a new result/field/list outcome. Keypad labels and retained history do not prove the current result.",
        "Keep controls and outcomes accessible: use labels for inputs, named result/status regions, and named lists or tables. Individual actions on repeated rows need names that identify the row, while assertions can use within to narrow their scope. Builder must render the real requested content in those regions, never hidden verification-only text.",
        "Check each explicit clause in requestText and originalRequest: named operations, example inputs, keyboard shortcuts, error recovery, saved state, colors and viewport widths need meaningful actions and expected results. Merely finding a button or checking console silence does not verify an outcome. Combine related controls into short meaningful scenarios rather than generating one behavior per key.",
        "For requested input flows, include applicable invalid-input and recovery checks. If the requested app has a history or saved-results list, also verify that an unchanged repeated submission does not duplicate the same saved outcome unless duplicates are intentional. Do not add history or a deduplication feature when the request does not need it. Validation rules must follow the domain, not assume every form is a calculator.",
        "Reserve evidence:'visual' for appearance that text cannot prove, such as color, alignment, overflow or canvas drawing. Such a program still declares initialState, opens the app, sets the requested viewport/state and captures an image; retain relevant typed or console assertions. Do not mark an undescribed interaction visual to avoid executing it.",
        "Every explicitly requested observable behavior has required:true. Optional means only an unrequested refinement. Do not downgrade persistence, input validation or saved state to optional.",
        "Choose defaults for reversible presentation choices. Ask one essential business question only when implementation would otherwise guess critical meaning, never ask again for supplied information. The question is one line, at most 300 characters, at most one question mark at the end, no numbered list or optional-feature checklist.",
        "This product generates a frontend demonstration. Explain real payments, cross-user backend data and other unsupported capabilities in outOfScope; never promise actual payment or backend execution. Prefer an honest useful frontend plan when feasible.",
        "Submit exactly one structured decision with submit_plan or request_clarification. Tool acceptance means the proposal awaits service confirmation, not that it was persisted. Do not reveal private reasoning or credentials. Keep responses concise and use one tool call per response.",
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
            if ("plan" in parsed.data) {
              parsed.data.plan = inheritPrograms(parsed.data.plan, context.data.previousPlan);
              if (!preservesPreviousBehavior(parsed.data.plan, context.data.previousPlan, context.data.requestText))
                throw await reject(`plan.behaviors:previous_behavior_required——${describeIncrementGap(parsed.data.plan, context.data.previousPlan)}`);
              for (const behavior of parsed.data.plan.behaviors) {
                const program = BehaviorProgramSchema.safeParse(behavior);
                if (!program.success)
                  throw await reject(`plan.behaviors.${behavior.id}:invalid_setup——${program.error.issues[0]?.message ?? '缺少明确初态或执行步骤'}`);
                const inherited = context.data.previousPlan?.behaviors.find(prior => prior.id === behavior.id);
                if (!inherited?.assertions?.length && behavior.assertions?.some(assertion => assertion.kind === 'text'))
                  throw await reject(`plan.behaviors.${behavior.id}:unscoped_outcome——页面文本不能证明特定结果区域；新程序必须用 target-text/value/count。旧错误程序需要明确修订，不能翻转其断言。`);
              }
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
      // Measured, not guessed: the sealed forty-one behaviour plan costs 2,905 tokens as prose and
      // 5,120 as soon as every behaviour carries a step list and an assertion — the smallest stepped
      // plan, with identical steps throughout. The 4,096 ceiling therefore truncates exactly the plans
      // this project now asks for, and a truncated plan arrives as malformed JSON that blames the
      // schema. The floor follows the plan we require; a configured value only raises it further.
      const maxTokens = Math.max(input.modelConfig.maxTokens ?? 0, COORDINATOR_OUTPUT_TOKENS);
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
