import { normalizeContext, Type, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { stream as openAIStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { CreateModelProfile, ModelTestResult } from "@pivloom/contracts";
import { createModelFetch, validateModelEndpoint } from "./transport.js";
import { probeModelVision } from "./vision.js";

const unknown = { streaming: "unknown", tools: "unknown", vision: "unknown" } as const;

/** Pi tests tools/streaming first, then sends image-only information to the same selected model. */
export async function testModelConnection(input: Pick<CreateModelProfile, "provider" | "baseUrl" | "modelId" | "apiKey">): Promise<ModelTestResult> {
  const testedAt = new Date().toISOString();
  await validateModelEndpoint(input.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const shared = {
      id: input.modelId, name: input.modelId, provider: "pivloom-byok", baseUrl: input.baseUrl,
      reasoning: false, input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 512,
    };
    const fetch = createModelFetch(input.baseUrl);
    let streaming = false;
    let receivedBytes = 0;
    const context: Context = {
      systemPrompt: "This is a connection test. First call connection_echo with text pivloom-probe. After its tool result, respond with exactly PIVLOOM_OK. Do not call any other tool.",
      tools: [{ name: "connection_echo", description: "A harmless local connection check; returns the given text without external actions.", parameters: Type.Object({ text: Type.Literal("pivloom-probe") }) }],
      messages: [{ role: "user", content: "Please test the connection now.", timestamp: Date.now() }],
    };
    type ToolChoice = "none" | { type: "function"; function: { name: string } } | undefined;
    const request = async (toolChoice: ToolChoice) => {
      const options = { apiKey: input.apiKey, fetch, signal: controller.signal, maxTokens: 512, timeoutMs: 25_000, maxRetries: 0 };
      const stream = input.provider === "openai-completions"
        ? openAIStream({ ...shared, api: "openai-completions", compat: { supportsStore: false, supportsDeveloperRole: false } } satisfies Model<"openai-completions">,
          normalizeContext(context), toolChoice === undefined ? options : { ...options, toolChoice })
        : anthropicStream({ ...shared, api: "anthropic-messages" } satisfies Model<"anthropic-messages">,
          normalizeContext(context), options);
      let result: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === "text_delta" || event.type === "toolcall_delta") {
          streaming = true;
          receivedBytes += Buffer.byteLength(event.delta);
          if (receivedBytes > 16_384) { controller.abort(); throw new Error("OUTPUT_LIMIT"); }
        }
        if (event.type === "error") throw new Error("PROVIDER_REQUEST_FAILED");
        if (event.type === "done") result = event.message;
      }
      if (!result) throw new Error("NO_COMPLETION");
      return result;
    };
    // Providers differ in how they accept a forced tool choice: some endpoints
    // reject `tool_choice` with a specific function outright. Negotiate the
    // capability instead of declaring the model unsupported: try the strongest
    // form first, then fall back to instructing the model through the prompt.
    const negotiate = async (strongest: ToolChoice) => {
      try { return await request(strongest); }
      catch (error) {
        if (strongest === undefined || controller.signal.aborted) throw error;
        return request(undefined);
      }
    };
    const first = await negotiate({ type: "function", function: { name: "connection_echo" } });
    const calls = first.content.filter((part) => part.type === "toolCall");
    if (calls.length !== 1 || calls[0].name !== "connection_echo" || calls[0].arguments.text !== "pivloom-probe") throw new Error("TOOL_UNSUPPORTED");
    context.messages.push(first, {
      role: "toolResult", toolCallId: calls[0].id, toolName: "connection_echo",
      content: [{ type: "text", text: "pivloom-probe" }], isError: false, timestamp: Date.now(),
    });
    const second = await negotiate("none");
    const text = second.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (!streaming || !text.includes("PIVLOOM_OK")) throw new Error("STREAM_OR_TOOL_REPLY_UNSUPPORTED");
    clearTimeout(timer);
    const visionController = new AbortController();
    const visionTimer = setTimeout(() => visionController.abort(), 40_000);
    let vision: Awaited<ReturnType<typeof probeModelVision>>;
    try { vision = await probeModelVision(input, fetch, visionController.signal); }
    finally { clearTimeout(visionTimer); }
    const visionMessage = {
      verified: "图像理解已通过实际图片内容测试。",
      unsupported: "当前模型明确拒绝图片输入，请选择支持图像的配置。",
      failed: "图片已送达但模型未正确识别内容，不能用于视觉验收。",
      unknown: "图像能力尚未证实，请重试或选择支持图像的配置。",
    }[vision.state];
    return { status: "passed", message: `连接、流式响应和工具调用均已验证。${visionMessage}`,
      capabilities: { streaming: "verified", tools: "verified", vision: vision.state }, testedAt };
  } catch {
    return {
      status: "failed", testedAt, capabilities: unknown,
      message: controller.signal.aborted ? "连接测试超时，请检查模型服务后重试。"
        : "连接测试未通过，请检查密钥、模型名称和协议；此模型需要支持流式响应与工具调用。",
    };
  } finally { clearTimeout(timer); }
}
