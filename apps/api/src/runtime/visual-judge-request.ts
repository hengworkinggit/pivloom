import { normalizeContext, type AssistantMessage, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { stream as openAIStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { VisualJudgePort } from "./replay-plan.js";
import type { ModelConfig } from "./types.js";
import { createRoleTokenTracker, type RunTokenBudget, type TokenUsage } from './token-budget.js';

/**
 * Builds the one model call the appearance layer needs, from the same configuration the review already
 * uses. It sends no tools at all, which is the point: the judge is asked what the captured pixels show
 * and can do nothing else, so it cannot start operating the browser and turn forty behaviours back into
 * half an hour of round trips.
 *
 * The shape follows the vision probe, which is the existing example of a one-shot image request in this
 * codebase. Errors are left to propagate to the caller: `judgeVisualBehaviours` already turns a failed
 * or unusable answer into a blocked verdict rather than a pass, so a provider outage degrades the
 * verdict instead of failing the whole review.
 */
export function createVisualJudgePort(config: ModelConfig, signal: AbortSignal,
  options: { tokenBudget?: RunTokenBudget; deadlineAt?: number; now?: () => number } = {}): VisualJudgePort & { usage(): TokenUsage } {
  const maxTokens = config.maxTokens ?? 1024;
  const tokens = createRoleTokenTracker(options.tokenBudget);
  const now = options.now ?? (() => performance.now());
  return {
    now,
    usage: () => tokens.usage(),
    async request(prompt, images) {
      signal.throwIfAborted();
      if (!config.fetch) throw new Error('MODEL_TRANSPORT_MISSING');
      const model = {
        id: config.id, name: config.id, provider: "pivloom-byok", baseUrl: config.baseUrl ?? "",
        reasoning: false, input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow ?? 32_000, maxTokens,
      };
      const content = [{ type: "text" as const, text: prompt },
        ...images.map((image): ImageContent => ({ type: "image", data: image.base64, mimeType: image.mimeType }))];
      const context = { systemPrompt: "", messages: [{ role: "user" as const, content, timestamp: Date.now() }] };
      const timeoutMs = options.deadlineAt === undefined ? 120_000 : Math.max(1, Math.min(120_000, options.deadlineAt - now()));
      const streamOptions = { apiKey: config.apiKey, signal, maxTokens, timeoutMs, maxRetries: 0 };
      // The wire protocol is `config.api`, the field the service sets from the resolved profile; the
      // provider name is the credential lease's identity (`pivloom-byok` in production) and only
      // happens to be the protocol in the vision probe's own input. Branching on the provider name
      // sent every OpenAI-compatible model down the Anthropic path, so the judge's answer came back
      // empty and every appearance behaviour blocked. The fallback matches `createServiceModel`.
      const api = config.api ?? (config.provider === "anthropic-messages" ? "anthropic-messages" : "openai-completions");
      const stream = tokens.stream(maxTokens, config.fetch, fetch => api === "openai-completions"
        ? openAIStream({ ...model, api: "openai-completions" } satisfies Model<"openai-completions">, normalizeContext(context), { ...streamOptions, fetch })
        : anthropicStream({ ...model, api: "anthropic-messages" } satisfies Model<"anthropic-messages">, normalizeContext(context), { ...streamOptions, fetch }));
      let result: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === "error") throw new Error(event.error.errorMessage ?? "VISUAL_JUDGE_PROVIDER_ERROR");
        if (event.type === "done") result = event.message;
      }
      return result?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
    },
  };
}
