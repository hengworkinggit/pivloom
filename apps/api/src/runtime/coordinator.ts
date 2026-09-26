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
  plan: { behaviors: Array<{ id: string; precondition?: unknown; action?: unknown; expected?: unknown; required?: unknown }>; groups?: Array<{ id: string; title?: unknown }> },
  previousPlan: { behaviors: Array<{ id: string; precondition?: unknown; action?: unknown; expected?: unknown; required?: unknown }>; groups?: Array<{ id: string; title?: unknown }> } | null | undefined,
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
        "Use the supplied project summary to preserve the original request and clarification answers. Submit schemaVersion 2 with exactly five stable groups G1–G5, each named for this app and containing at least one required atomic behavior. Every child behavior must belong to exactly one group; five groups do not mean only five requirements.",
        // A measured run kept failing the increment guard while the prose rule was already present, and
        // the guard only compares id, required, precondition, action and expected: asking for steps gave
        // the model a reason to reword that prose, which the guard then correctly rejected. Saying
        // verbatim, and saying which fields may change, removes the ambiguity.
        "The plan has exactly five groups and no more: their ids are literally G1, G2, G3, G4 and G5. Never emit G6, never renumber, never invent another id. Every behaviour id in the plan - preserved or new - appears in exactly one of these five groups, so a new requirement joins an existing group rather than creating a sixth.",
        "When the project summary contains a previous plan, every required behaviour in it must appear in your plan with the same id and with precondition, action and expected copied VERBATIM, character for character. You may add steps and assertions to those behaviours and you may add entirely new behaviours with new ids; you may not reword, rename, merge or drop an existing one.",
        "Use the five groups as distinct application-specific facets in this order: G1 primary outcome, G2 input and control, G3 edge cases or progression, G4 result and state, G5 visual layout or restart and persistence. Give each group a title that describes the actual app. Do not use a group only to inventory visible buttons when the request asks what those buttons must do.",
        // A measured coordinator run failed twice on the group count and the behavior-id format while
        // every rule above was already stated in prose, so the shape is shown literally: models follow
        // a worked example far more reliably than a rule they have to translate into structure.
        // A measured run left three behaviours without steps or assertions, and because the deterministic
        // layer can only execute what the plan describes, those behaviours could not be verified at all:
        // they were recorded blocked and the whole check with them. The shape example below shows what
        // steps and assertions look like; this says that having them is not optional, and names the one
        // exception so a behaviour that genuinely cannot be described that way is declared, not left blank.
        // A measured run produced a behaviour whose steps were an open followed by assertions about a
        // history list it had never created, so one step was not enough for that behaviour. Requiring
        // more interactions of every behaviour, however, turned thirty-seven passes into thirty-five
        // and eight point three minutes into eleven: the rule belongs only where the expectation
        // depends on state that earlier actions create.
        // A measured increment inherited the previous revision's plan, and the behaviours carried over from
        // it had no steps: only the newly added ones did. Thirty-two of forty-four behaviours were therefore
        // uncompilable and the acceptance reported three passes and forty-one blocked. The prose of an
        // inherited behaviour must not change, but steps and assertions are explicitly not a semantic change,
        // so they can and must be written for it.
        "When you carry a behaviour over from the previous plan, you must write `steps` and `assertions` for it as well - its title, precondition, action, expected and required must stay exactly as they were, but a behaviour whose prose you inherit without its steps cannot be executed or checked. Filling them in is not a change to the behaviour.",
        // Same-named controls are the second shape of the prediction problem, and the runtime resolver cannot
        // help with them: it is handed ref, role and name, so twenty buttons all called 删除 leave it as blind
        // as the kernel. The plan has to ask for a name that distinguishes them. I withdrew this instruction
        // once because it pushed the coordinator towards literal labels and the resulting misses blocked whole
        // behaviours; the resolver now recovers a wrongly guessed name, so the two changes cover both shapes
        // together and this one can stand.
        "When several controls share an accessible name - the usual case being a list where every row carries the same button - the expectation must require a name that distinguishes them, for example the row's own text included in the button name. Identical names are also an accessibility defect: a screen reader user cannot tell those controls apart either.",
        "Every behaviour must carry at least one `steps` entry and at least one `assertions` entry. A behaviour without them cannot be executed or checked, and the whole acceptance then reports it as unverifiable. The only exception is an appearance-only claim - a layout, colour or alignment result that no interaction can settle - and for those set evidence to 'visual' instead; never use that to skip an interaction you did not describe.",
        "Exact shape (abbreviated values, all five groups present, ids in this form): {\"schemaVersion\":2,\"goal\":\"…\",\"changeSummary\":\"…\",\"assumptions\":[],\"outOfScope\":[],\"replacements\":[],\"behaviors\":[{\"id\":\"B01\",\"title\":\"…\",\"precondition\":\"…\",\"action\":\"…\",\"expected\":\"…\",\"required\":true,\"steps\":[{\"type\":\"open\",\"path\":\"/\"},{\"type\":\"click\",\"role\":\"button\",\"name\":\"添加\"},{\"type\":\"capture\"}],\"assertions\":[{\"kind\":\"text\",\"text\":\"…\",\"negated\":false}]}],\"groups\":[{\"id\":\"G1\",\"title\":\"…\",\"behaviorIds\":[\"B01\"]},{\"id\":\"G2\",\"title\":\"…\",\"behaviorIds\":[\"B02\"]},{\"id\":\"G3\",\"title\":\"…\",\"behaviorIds\":[\"B03\"]},{\"id\":\"G4\",\"title\":\"…\",\"behaviorIds\":[\"B04\"]},{\"id\":\"G5\",\"title\":\"…\",\"behaviorIds\":[\"B05\"]}]}. Behavior ids are always B01, B02, … with two digits, group ids are exactly G1 to G5, and every behavior id appears in exactly one group.",
        "On an increment preserve EVERY previous required behavior's ID, precondition, action, expected result and required flag, in the same group. Keep all five group names and IDs stable. Carry all prior replacement records unchanged so retired IDs stay retired. Add new behaviors with new IDs. Never reuse an old ID for a changed meaning. Only when the user's current request explicitly changes an old behavior may you record a replacement: oldBehaviorId, newBehaviorId, a verbatim userRequestQuote expressing the change, and reason; keep the replacement in the old group. Do not silently omit a prior requirement.",
        "Reviewer starts in a fresh isolated browser and can navigate/reload the bound app, fill/select/click/press controls and inspect DOM/source. Write acceptance steps using those capabilities: verify initial empty state before adding records, and persistence by reloading. Do not require developer tools, manually clearing storage, editing DOM or backend access as test steps. Use the smallest dataset that distinguishes the requested behavior; do not invent extra business requirements.",
        "Each behavior target must include a meaningful interaction from the requested workflow and an observed result. Combine static initial-state assertions with the first actual business flow, such as requested form validation, instead of a standalone open-and-look target. Preserve every explicit requirement, including the initial empty state; do not add arbitrary clicks or new functionality just to produce action evidence.",
        "Before submit_plan, compare every explicit clause of requestText and originalRequest against the required targets. If the user named an operation, example expression, numeric form, keyboard shortcut, error-and-recovery path, saved state, color, or viewport width, include an action and expected observation that actually tests it. For any interface that accepts input, also include a required behaviour that exercises an invalid input and the recovery after it, and one that repeats a submission, whether or not the user named them; a fix that only states the rule to the builder cannot be checked otherwise. A control merely existing, a generic 'works' assertion, or a different viewport does not cover the named requirement. Fill any missing clause before submitting.",
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
              throw await reject(`plan.behaviors:previous_behavior_required——${describeIncrementGap(parsed.data.plan, context.data.previousPlan)}`);
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
