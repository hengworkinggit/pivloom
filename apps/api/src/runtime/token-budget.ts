import type { AssistantMessage, AssistantMessageEventStream, Usage } from "@earendil-works/pi-ai";
import type { RoleUsage } from "@pivloom/contracts";
import { RuntimeError } from "./types.js";

type ProviderUsage = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;
interface TokenSample { input: number | null; output: number | null; total: number | null; cachedTokens: number | null }
export interface TokenUsage extends TokenSample {
  modelCalls: number;
  toolCalls: number;
  elapsedMs: number;
  source: RoleUsage["source"];
}
export interface RunTokenBudget {
  reserve(estimatedInputTokens: number, maxOutputTokens: number): { settle(usage?: ProviderUsage, final?: boolean): TokenSample };
  snapshot(): { limitTokens: number | null; accountedTokens: number; remainingTokens: number | null; requests: number; pendingRequests: number; unreportedRequests: number };
}

/** One ledger per run, shared by every role and correction request. */
export function createRunTokenBudget(limitTokens?: number): RunTokenBudget {
  if (limitTokens !== undefined && (!Number.isSafeInteger(limitTokens) || limitTokens < 1))
    throw new RuntimeError("TOKEN_BUDGET_INVALID", "显式 Token 预算必须为正整数");
  let accountedTokens = 0, requests = 0, pendingRequests = 0, unreportedRequests = 0;
  return {
    reserve(estimatedInputTokens, maxOutputTokens) {
      if (![estimatedInputTokens, maxOutputTokens].every((value) => Number.isSafeInteger(value) && value > 0))
        throw new RuntimeError("TOKEN_BUDGET_INVALID", "Token 请求预留无效");
      const reserved = estimatedInputTokens + maxOutputTokens;
      if (!Number.isSafeInteger(reserved) || (limitTokens !== undefined && accountedTokens + reserved > limitTokens))
        throw new RuntimeError("TOKEN_BUDGET_EXCEEDED", "本次任务 Token 预算不足，已停止新的模型请求");
      accountedTokens += reserved; requests++; pendingRequests++;
      let settled: TokenSample | undefined;
      return { settle(usage, final = true) {
        if (settled) return settled;
        const valid = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0;
        // Pi initializes missing fields to zero. Even an explicit zero cannot
        // safely release a reservation because the SDK loses that distinction.
        const input = usage && valid(usage.input) && usage.input > 0 ? usage.input : null;
        const output = final && usage && valid(usage.output) && usage.output > 0 ? usage.output : null;
        const complete = input !== null && output !== null && valid(usage?.cacheRead) && valid(usage?.cacheWrite);
        const observed = usage ? Math.max(
          valid(usage.totalTokens) ? usage.totalTokens : 0,
          [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce((sum, value) => sum + (valid(value) ? value : 0), 0),
        ) : 0;
        const cached = usage && valid(usage.cacheRead) && valid(usage.cacheWrite) ? usage.cacheRead + usage.cacheWrite : 0;
        // The SDK also initializes absent cache fields to zero; only a positive
        // amount is distinguishable without retaining raw provider payloads.
        settled = { input, output, total: complete ? observed : null, cachedTokens: cached > 0 ? cached : null };
        accountedTokens += (complete ? observed : Math.max(reserved, observed)) - reserved;
        pendingRequests--; if (!complete) unreportedRequests++;
        return settled;
      } };
    },
    snapshot: () => ({ limitTokens: limitTokens ?? null, accountedTokens, remainingTokens: limitTokens === undefined ? null : Math.max(0, limitTokens - accountedTokens), requests, pendingRequests, unreportedRequests }),
  };
}

/** Keeps one role's reported usage separate while charging its shared run. */
export function createRoleTokenTracker(budget = createRunTokenBudget()) {
  const samples: TokenSample[] = [];
  const startedAt = performance.now();
  let modelCalls = 0, toolCalls = 0;
  let failure: RuntimeError | undefined;
  const fail = (error: RuntimeError) => failure ??= error;
  return {
    get failure() { return failure; },
    recordToolCall() { toolCalls++; },
    stream(maxOutputTokens: number, fetch: typeof globalThis.fetch | undefined, start: (fetch: typeof globalThis.fetch) => AssistantMessageEventStream) {
      if (failure) throw failure;
      let reservation: ReturnType<RunTokenBudget["reserve"]> | undefined;
      let attempted = false, closed = false;
      const settle = (message?: AssistantMessage) => {
        if (closed) return;
        closed = true;
        if (reservation) samples.push(reservation.settle(message?.usage,
          !failure && !!message && message.stopReason !== "error" && message.stopReason !== "aborted"));
      };
      const budgetedFetch: typeof globalThis.fetch = async (url, init) => {
        const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
        signal?.throwIfAborted();
        if (failure) throw failure;
        // SDK retries are disabled. An unexpected second fetch must never reuse
        // this stream's reservation, even if the provider swallows its error.
        if (attempted || closed) throw fail(new RuntimeError("MODEL_REQUEST_REPEATED", "模型请求出现未授权的重复调用，已停止执行"));
        attempted = true;
        try {
          // Both supported Pi SDK adapters serialize their final JSON body to
          // a string. Reject other bodies rather than consume/replay a stream.
          if (typeof init?.body !== "string") throw new Error("Unsupported model request body");
          const body = init.body;
          const bytes = Buffer.byteLength(body, "utf8");
          if (!bytes || bytes > 16 * 1024 * 1024) throw new Error("Invalid model request size");
          const payload: unknown = JSON.parse(body);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)
            || !("messages" in payload) || !Array.isArray(payload.messages)) throw new Error("Invalid model request body");
          const limits = ["max_tokens", "max_completion_tokens"]
            .filter((key) => Object.hasOwn(payload, key)).map((key) => Reflect.get(payload, key));
          if (!limits.length || ![maxOutputTokens, ...limits].every((value) => Number.isSafeInteger(value) && value > 0))
            throw new Error("Invalid model output limit");
          if (closed || failure) throw failure ?? new Error("Model stream already ended");
          // Count the final wire body, including thinking, tools and results.
          // Local Pi metadata is absent. Keep the conservative bytes/token and
          // framing margins; this remains an estimate, not provider billing.
          const estimatedInput = Math.ceil(bytes / 3) + 256 + payload.messages.length * 16;
          reservation = budget.reserve(estimatedInput, Math.max(maxOutputTokens, ...limits));
        } catch (error) {
          signal?.throwIfAborted();
          throw fail(error instanceof RuntimeError ? error : new RuntimeError("TOKEN_BUDGET_INVALID", "无法安全估算模型请求，已停止新的调用"));
        }
        modelCalls++;
        return (fetch ?? globalThis.fetch)(url, init);
      };
      try {
        const stream = start(budgetedFetch);
        // Pi resolves result() when it pushes its terminal event, before the
        // agent consumes that event and can start another request/tool turn.
        // Error/abort usage may be provisional. settle keeps the full reservation
        // and any larger observed amount in those cases.
        void stream.result().then(settle, () => settle());
        return stream;
      } catch (error) {
        settle();
        throw error;
      }
    },
    usage(): TokenUsage {
      const sum = (field: keyof TokenSample) => samples.length && samples.every((sample) => sample[field] !== null)
        ? samples.reduce((total, sample) => total + sample[field]!, 0) : null;
      const values = { input: sum("input"), output: sum("output"), total: sum("total"), cachedTokens: sum("cachedTokens") };
      const known = Object.values(values).filter((value) => value !== null).length;
      return { ...values, modelCalls, toolCalls, elapsedMs: Math.max(0, performance.now() - startedAt),
        source: known === 0 ? "unreported" : known === 4 ? "reported" : "partial" };
    },
  };
}
