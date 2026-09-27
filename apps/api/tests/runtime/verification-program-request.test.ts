import { type TSchema } from '@earendil-works/pi-ai';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createVerificationProgramCompiler } from '../../src/runtime/verification-program-request.js';
import { createVisualJudgePort } from '../../src/runtime/visual-judge-request.js';
import { createRunTokenBudget } from '../../src/runtime/token-budget.js';
import type { ModelConfig, ProbeEvent } from '../../src/runtime/types.js';

const jsonSchema = z.toJSONSchema(z.object({ programs: z.array(z.object({
  behaviorId: z.string(), initialState: z.enum(['fresh', 'continue']),
})) }));
const parameters = jsonSchema as TSchema;
const answer = { programs: [{ behaviorId: 'B01', initialState: 'fresh' }] };
const key = 'compiler-private-fixture-key';
type Protocol = 'openai-completions' | 'anthropic-messages';
type Call = { name: string; arguments: unknown };
const calls = [{ name: 'submit_programs', arguments: answer }];

function openAIResponse(submissions: Call[] = calls, finish = 'tool_calls') {
  const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => ({
    id: 'compiler-response', object: 'chat.completion.chunk', created: 1, model: 'compiler-fixture',
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
  });
  return new Response([
    chunk({ role: 'assistant', tool_calls: submissions.map((call, index) => ({ index, id: `call-${index}`,
      type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, null),
    chunk({}, finish, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
}

function config(api: Protocol, fetch: typeof globalThis.fetch, maxTokens?: number): ModelConfig {
  // The credential identity deliberately differs from the wire protocol.
  return { provider: 'pivloom-byok', api, id: 'compiler-fixture', baseUrl: 'https://compiler-fixture.invalid/v1',
    apiKey: key, fetch, ...(maxTokens === undefined ? {} : { maxTokens }) };
}

function anthropicResponse(submissions: Call[] = calls, finish = 'tool_use') {
  const events = [
    { type: 'message_start', message: { id: 'compiler-response', type: 'message', role: 'assistant',
      model: 'compiler-fixture', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0 } } },
    ...submissions.flatMap((call, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name: call.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
const responseFor = (api: Protocol) => api === 'openai-completions' ? openAIResponse : anthropicResponse;

test('the OpenAI wire advertises only submit_programs with the caller schema and returns its actual arguments', async () => {
  const wire: Record<string, unknown>[] = [], events: ProbeEvent[] = [];
  const budget = createRunTokenBudget(40_000);
  const compiler = createVerificationProgramCompiler(config('openai-completions', async (_url, init) => {
    wire.push(JSON.parse(String(init?.body)));
    return openAIResponse();
  }), new AbortController().signal, { deadlineAt: 120_000, now: () => 0, tokenBudget: budget,
    onEvent: (event) => { events.push(event); } });
  expect(await compiler.request(parameters, 'Compile the missing saved-list requirement.')).toEqual(answer);
  expect(compiler.maxOutputTokens).toBe(16_384);
  expect(wire).toHaveLength(1);
  expect(wire[0]).toMatchObject({ tools: [{ type: 'function', function: { name: 'submit_programs', parameters } }],
    tool_choice: 'auto' });
  expect(wire[0].tools).toHaveLength(1);
  expect(wire[0].max_tokens ?? wire[0].max_completion_tokens).toBe(16_384);
  expect(compiler.usage()).toMatchObject({ modelCalls: 1, toolCalls: 1, input: 11, output: 7, total: 18 });
  expect(budget.snapshot()).toMatchObject({ requests: 1, pendingRequests: 0, accountedTokens: 18 });
  expect(events.filter((event) => event.type === 'model.stream.started')).toMatchObject([{ success: true, requestNumber: 1 }]);
});

test('the Anthropic wire uses a compatible automatic choice, respects its output cap and shares usage', async () => {
  const wire: Record<string, unknown>[] = [];
  const budget = createRunTokenBudget(40_000);
  const compiler = createVerificationProgramCompiler(config('anthropic-messages', async (_url, init) => {
    wire.push(JSON.parse(String(init?.body)));
    return anthropicResponse();
  }, 8_192), new AbortController().signal, { deadlineAt: 120_000, now: () => 0, tokenBudget: budget });
  expect(await compiler.request(parameters, 'Compile B01.')).toEqual(answer);
  expect(compiler.maxOutputTokens).toBe(8_192);
  expect(wire).toHaveLength(1);
  expect(wire[0]).toMatchObject({ max_tokens: 8_192,
    // Pi's Anthropic adapter retains type/properties/required and adapts root metadata.
    tools: [{ name: 'submit_programs', input_schema: { type: 'object', properties: jsonSchema.properties, required: ['programs'] } }],
    tool_choice: { type: 'auto' } });
  expect(wire[0].tools).toHaveLength(1);
  expect(compiler.usage()).toMatchObject({ modelCalls: 1, toolCalls: 1, input: 11, output: 7, total: 18 });
  expect(budget.snapshot()).toMatchObject({ accountedTokens: 18, requests: 1, pendingRequests: 0 });
});

test.each(['openai-completions', 'anthropic-messages'] as const)('%s rejects a wire token-limit stop even when its tool arguments are complete', async (api) => {
  const compiler = createVerificationProgramCompiler(config(api, async () => responseFor(api)(calls,
    api === 'openai-completions' ? 'length' : 'max_tokens'), 32_768), new AbortController().signal,
  { deadlineAt: 120_000, now: () => 0 });
  expect(compiler.maxOutputTokens).toBe(16_384);
  await expect(compiler.request(parameters, 'Compile B01.')).rejects.toMatchObject({ code: 'VERIFICATION_PROGRAM_INVALID' });
  expect(compiler.usage()).toMatchObject({ modelCalls: 1, toolCalls: 1 });
});

test.each([
  ['missing', []], ['unexpected', [{ name: 'browser_eval', arguments: { script: 'forbidden' } }]],
  ['multiple', [...calls, ...calls]],
] as const)('a %s tool submission is refused rather than guessed or executed', async (_label, submissions) => {
  const compiler = createVerificationProgramCompiler(config('openai-completions', async () => openAIResponse([...submissions])),
    new AbortController().signal, { deadlineAt: 120_000, now: () => 0 });
  await expect(compiler.request(parameters, 'Compile B01.')).rejects.toMatchObject({ code: 'VERIFICATION_PROGRAM_INVALID' });
  expect(compiler.usage()).toMatchObject({ modelCalls: 1, toolCalls: submissions.length });
});

test('shared budget exhaustion, an expired deadline and prior cancellation perform no provider I/O', async () => {
  let requests = 0;
  const model = config('openai-completions', async () => { requests++; return openAIResponse(); });
  const expired = createVerificationProgramCompiler(model, new AbortController().signal, { deadlineAt: 1, now: () => 1 });
  await expect(expired.request(parameters, 'Compile B01.')).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
  const cancelled = createVerificationProgramCompiler(model, AbortSignal.abort(`private:${key}`), { deadlineAt: 1, now: () => 0 });
  await expect(cancelled.request(parameters, 'Compile B01.')).rejects.toMatchObject({ code: 'CANCELLED' });
  const budget = createRunTokenBudget(10);
  const limited = createVerificationProgramCompiler(model, new AbortController().signal,
    { deadlineAt: 120_000, now: () => 0, tokenBudget: budget });
  await expect(limited.request(parameters, 'Compile B01.')).rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXCEEDED' });
  expect(requests).toBe(0);
  expect(limited.usage()).toMatchObject({ modelCalls: 0, toolCalls: 0 });
  expect(budget.snapshot()).toMatchObject({ requests: 0, pendingRequests: 0 });
});

test('provider error payloads and arbitrary callback errors cannot expose credentials or generated text', async () => {
  const events: ProbeEvent[] = [];
  for (const mode of ['provider', 'callback']) {
    const compiler = createVerificationProgramCompiler(config('openai-completions', async () => mode === 'provider'
      ? new Response(JSON.stringify({ error: { message: `${key} private generated content`, type: 'provider_error' } }), { status: 400 })
      : openAIResponse()), new AbortController().signal, { deadlineAt: 120_000, now: () => 0,
      onEvent: (event) => { events.push(event); throw new Error(`${key} callback detail`); } });
    const error = await compiler.request(parameters, 'Compile B01.').catch((error: unknown) => error);
    expect(error).toMatchObject({ code: mode === 'provider' ? 'MODEL_REQUEST_FAILED' : 'EVENT_APPEND_FAILED' });
    expect(String(error)).not.toContain(key);
    expect(String(error)).not.toContain('generated content');
  }
  expect(JSON.stringify(events)).not.toContain(key);
});

test.each(['openai-completions', 'anthropic-messages'] as const)('%s cancels an actual open HTTP stream and reports progress only after its first real delta', async (api) => {
  let response: ServerResponse | undefined, closed = false;
  const server = createServer((_request, outgoing) => {
    response = outgoing;
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.flushHeaders();
    outgoing.on('close', () => { closed = true; });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback port');
  const controller = new AbortController(), events: ProbeEvent[] = [], budget = createRunTokenBudget(40_000);
  const compiler = createVerificationProgramCompiler({ ...config(api, globalThis.fetch), baseUrl: `http://127.0.0.1:${address.port}/v1` },
    controller.signal, { deadlineAt: performance.now() + 5_000, tokenBudget: budget, onEvent: (event) => { events.push(event); } });
  const pending = compiler.request(parameters, 'Compile B01.');
  const outcome = pending.catch((error: unknown) => error);
  try {
    await expect.poll(() => !!response).toBe(true);
    expect(events).toEqual([]); // Neither dispatch nor HTTP headers count as model progress.
    const chunks = (await responseFor(api)().text()).split('\n\n');
    response!.write(chunks.slice(0, api === 'openai-completions' ? 1 : 3).join('\n\n') + '\n\n');
    await expect.poll(() => events.length).toBe(1);
    controller.abort(`private:${key}`);
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => closed).toBe(true);
    expect(events).toMatchObject([{ type: 'model.stream.started', success: true, requestNumber: 1 }]);
    expect(compiler.usage()).toMatchObject({ modelCalls: 1, output: null, total: null });
    expect(budget.snapshot()).toMatchObject({ requests: 1, pendingRequests: 0, unreportedRequests: 1 });
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pending.catch(() => {});
  }
});

test('a fractional remaining deadline aborts a stalled HTTP body without inventing model progress', async () => {
  let response: ServerResponse | undefined, closed = false;
  const server = createServer((_request, outgoing) => {
    response = outgoing;
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.flushHeaders();
    outgoing.on('close', () => { closed = true; });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback port');
  const events: ProbeEvent[] = [];
  const compiler = createVerificationProgramCompiler({ ...config('openai-completions', globalThis.fetch),
    baseUrl: `http://127.0.0.1:${address.port}/v1` }, new AbortController().signal,
  { deadlineAt: 250.5, now: () => 0, onEvent: (event) => { events.push(event); } });
  try {
    await expect(compiler.request(parameters, 'Compile B01.')).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
    expect(response).toBeDefined();
    await expect.poll(() => closed).toBe(true);
    expect(events).toEqual([]);
    expect(compiler.usage()).toMatchObject({ modelCalls: 1, toolCalls: 0, output: null });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('successive caller chunks share usage and emit one real stream-start event per request', async () => {
  const events: ProbeEvent[] = [], budget = createRunTokenBudget(40_000);
  let currentTime = 0, requests = 0;
  const compiler = createVerificationProgramCompiler(config('openai-completions', async () => {
    requests++;
    return openAIResponse();
  }), new AbortController().signal, { deadlineAt: 120_000, now: () => currentTime,
    tokenBudget: budget, onEvent: (event) => { events.push(event); } });
  await compiler.request(parameters, 'Compile B01.');
  await compiler.request(parameters, 'Compile B02.');
  currentTime = 120_000;
  await expect(compiler.request(parameters, 'Compile B03.')).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
  expect(requests).toBe(2);
  expect(compiler.usage()).toMatchObject({ modelCalls: 2, toolCalls: 2, input: 22, output: 14, total: 36 });
  expect(budget.snapshot()).toMatchObject({ requests: 2, accountedTokens: 36, pendingRequests: 0 });
  expect(events).toMatchObject([{ requestNumber: 1, success: true }, { requestNumber: 2, success: true }]);
});

test.each(['openai-completions', 'anthropic-messages'] as const)('%s visual requests accept a fractional remaining deadline through the real SDK adapter', async (api) => {
  let requests = 0;
  const port = createVisualJudgePort(config(api, async () => {
    requests++;
    const events = api === 'openai-completions'
      ? [{ id: 'visual-response', object: 'chat.completion.chunk', created: 1, model: 'compiler-fixture',
        choices: [{ index: 0, delta: { content: 'Visible item' }, finish_reason: 'stop' }] }]
      : [
        { type: 'message_start', message: { id: 'visual-response', type: 'message', role: 'assistant',
          model: 'compiler-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Visible item' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ];
    return new Response(events.map((event) => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('')
      + (api === 'openai-completions' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
  }), new AbortController().signal, { deadlineAt: 1_000.5, now: () => 0 });
  await expect(port.request('Judge the image.', [{ base64: 'iVBORw0KGgo=', mimeType: 'image/png' }])).resolves.toBe('Visible item');
  expect(requests).toBe(1);
});
