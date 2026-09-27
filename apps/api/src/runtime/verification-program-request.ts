import { randomUUID } from 'node:crypto';
import { normalizeContext, type AssistantMessage, type Model, type TSchema } from '@earendil-works/pi-ai';
import { stream as openAIStream } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { createRoleTokenTracker, type RunTokenBudget, type TokenUsage } from './token-budget.js';
import { RuntimeError, type ModelConfig, type ProbeEventSink } from './types.js';

export interface VerificationProgramCompiler {
  request(parameters: TSchema, prompt: string): Promise<unknown>;
  usage(): TokenUsage;
  maxOutputTokens: number;
}

/** A schema-bound submission port; the caller validates and seals the returned programs. */
export function createVerificationProgramCompiler(config: ModelConfig, signal: AbortSignal,
  options: { tokenBudget?: RunTokenBudget; deadlineAt: number; now?: () => number; onEvent?: ProbeEventSink },
): VerificationProgramCompiler {
  const maxOutputTokens = Math.min(config.maxTokens ?? 16_384, 16_384);
  const tokens = createRoleTokenTracker(options.tokenBudget);
  const now = options.now ?? (() => performance.now());
  let requestNumber = 0;
  const failure = (code: string, message: string) => new RuntimeError(code, message, undefined, tokens.usage());
  const checkCancellation = () => {
    if (signal.aborted) throw failure(signal.reason === 'RUN_TIMEOUT' ? 'RUN_TIMEOUT' : 'CANCELLED', '验证程序编译已停止');
  };
  return {
    maxOutputTokens,
    usage: () => tokens.usage(),
    async request(parameters, prompt) {
      checkCancellation();
      const remainingMs = options.deadlineAt - now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0)
        throw failure('RUN_TIMEOUT', '验证程序编译已达到截止时间');
      if (!config.fetch) throw failure('MODEL_TRANSPORT_MISSING', '验证程序编译缺少模型传输配置');
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
        throw failure('MODEL_CONFIGURATION_INVALID', '验证程序编译输出限额无效');
      const api = config.api ?? (config.provider === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions');
      if (api !== 'openai-completions' && api !== 'anthropic-messages')
        throw failure('MODEL_CONFIGURATION_INVALID', '验证程序编译不支持当前模型协议');
      const model = {
        id: config.id, name: config.id, provider: 'pivloom-byok', baseUrl: config.baseUrl ?? '',
        reasoning: false, input: ['text'] as 'text'[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow ?? 32_000, maxTokens: maxOutputTokens,
      };
      const context = normalizeContext({
        systemPrompt: 'Compile only the requested verification programs. Submit exactly one submit_programs call matching its schema. You cannot browse, execute programs, modify requirements or call other tools.',
        tools: [{ name: 'submit_programs', description: 'Submit verification programs for caller validation. Submission does not execute or pass any test.', parameters }],
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      });
      // Both SDKs require an integer; performance.now() leaves a fractional remainder.
      const timeoutMs = Math.max(1, Math.floor(Math.min(120_000, remainingMs)));
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      timer.unref();
      const requestSignal = AbortSignal.any([signal, timeout.signal]);
      const streamOptions = { apiKey: config.apiKey, signal: requestSignal, maxTokens: maxOutputTokens, timeoutMs, maxRetries: 0 };
      const currentRequest = ++requestNumber;
      let receivedDelta = false;
      try {
        const stream = tokens.stream(maxOutputTokens, config.fetch, fetch => api === 'openai-completions'
          ? openAIStream({ ...model, api: 'openai-completions' } satisfies Model<'openai-completions'>, context,
            { ...streamOptions, fetch, toolChoice: 'auto' })
          : anthropicStream({ ...model, api: 'anthropic-messages' } satisfies Model<'anthropic-messages'>, context,
            { ...streamOptions, fetch, toolChoice: 'auto' }));
        let result: AssistantMessage | undefined;
        for await (const event of stream) {
          if ('delta' in event && typeof event.delta === 'string' && event.delta.length && !receivedDelta) {
            receivedDelta = true;
            try {
              await options.onEvent?.({ id: randomUUID(), at: new Date().toISOString(), type: 'model.stream.started',
                requestNumber: currentRequest, success: true, message: '验证程序编译已收到实际模型响应' });
            } catch { throw failure('EVENT_APPEND_FAILED', '验证程序编译事件保存失败'); }
          }
          if (event.type === 'toolcall_end') tokens.recordToolCall();
          if (event.type === 'error') throw failure('MODEL_REQUEST_FAILED', '验证程序编译模型请求失败');
          if (event.type === 'done') result = event.message;
        }
        checkCancellation();
        if (timeout.signal.aborted || now() >= options.deadlineAt)
          throw failure('RUN_TIMEOUT', '验证程序编译已达到截止时间');
        if (tokens.failure) throw tokens.failure;
        if (!result || result.stopReason !== 'toolUse')
          throw failure('VERIFICATION_PROGRAM_INVALID', '模型未完整提交验证程序，输出可能被截断');
        const submissions = result.content.filter((part) => part.type === 'toolCall');
        if (submissions.length !== 1 || submissions[0].name !== 'submit_programs')
          throw failure('VERIFICATION_PROGRAM_INVALID', '模型必须提交且只提交一次验证程序');
        return submissions[0].arguments;
      } catch (error) {
        checkCancellation();
        if (timeout.signal.aborted || now() >= options.deadlineAt)
          throw failure('RUN_TIMEOUT', '验证程序编译已达到截止时间');
        if (tokens.failure) throw tokens.failure;
        if (error instanceof RuntimeError) throw error;
        // Provider errors may contain credentials, URLs or generated content. They never leave this port.
        throw failure('MODEL_REQUEST_FAILED', '验证程序编译模型请求失败');
      } finally {
        clearTimeout(timer);
        timeout.abort();
      }
    },
  };
}
