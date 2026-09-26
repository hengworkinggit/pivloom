import { createHash, randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import type { Plan } from '@pivloom/contracts';
import { allowsRenderOnlyEvidence } from '@pivloom/contracts';
import { createSourceStore } from '../../src/storage/source.js';
import { createArtifactStore } from '../../src/storage/artifacts.js';
import { createSourceSnapshot } from '../../src/runtime/snapshot.js';
import { runReview, assertVerifiedReviewReceipt } from '../../src/generation/review.js';
import type { ProbeEvent } from '../../src/runtime/types.js';
import { RuntimeError } from '../../src/runtime/types.js';
import { createRunTokenBudget } from '../../src/runtime/token-budget.js';
import type { SandboxConnection } from '../../src/runtime/workspace.js';
import { PNG_BASE64 } from '../runtime/replay-fixture.js';

/**
 * End-to-end through `runReview`: a plan whose behaviours carry executable steps
 * must be reported by the scripted layer alone, with the provider transport never
 * called, while still passing every check `finishReview` applies. The artifact
 * store and sandbox transport are the only external fixtures.
 */
const CLICK_ADD = "'click' '@e2'";
/**
 * `added` is injectable so the fallback test can script a page that already
 * changed, which keeps the model path's stub from having to fake a full check.
 */
async function fixture(plan: Plan, options: { added?: () => boolean } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const objects = { upload: async (key: string, body: Uint8Array) => { blobs.set(key, body); }, download: async (key: string) => blobs.get(key)!, list: async () => [] };
  const sources = createSourceStore({ url: 'http://fixture.invalid', secret: 'fixture', objects });
  const files = [{ path: 'src/App.tsx', content: Buffer.from('export default function App(){return null}'), sha256: '' }];
  files[0].sha256 = createHash('sha256').update(files[0].content).digest('hex');
  const source = await sources.save({ ownerId: randomUUID(), projectId: randomUUID(), revisionId: randomUUID() },
    createSourceSnapshot(files).bundle.templateVersion, files);
  const binding = { runId: randomUUID(), roleRunId: randomUUID(), attempt: 0, revisionId: source.revisionId,
    sourceHash: source.sourceHash, sandboxId: 'fixture', browserSessionId: 'pivloom-' + randomUUID() };
  const staging = new Map<string, Uint8Array>();
  const remote = { clicks: 0, snapshots: 0, modelCalls: 0 };
  // The plan's one real interaction is the only thing that may change the page;
  // if the script did not actually click, the asserted text never appears.
  const added = options.added ?? (() => remote.clicks > 0);
  const connection: SandboxConnection = { sandboxId: 'fixture', kill: async () => {}, isRunning: async () => true,
    renew: async () => {}, close: async () => {},
    endpoint: async () => ({ url: 'http://preview-fixture.invalid', headers: {} }),
    read: async () => Buffer.from(PNG_BASE64, 'base64'),
    write: async (path, body) => { staging.set(path, body); },
    run: async (command) => {
      let stdoutTail = '';
      if (command.startsWith('node /opt/pivloom/source-io.mjs')) {
        const request = JSON.parse(Buffer.from(staging.get(command.split("'")[1])!).toString());
        stdoutTail = request.op === 'read' ? JSON.stringify({ data: files[0].content.toString('base64') })
          : JSON.stringify({ files: files.map((file) => file.path) });
      } else {
        let data: Record<string, unknown> = {};
        if (command.endsWith("'get' 'url'")) data = { url: 'http://127.0.0.1:4173/' };
        else if (command.endsWith("'get' 'text' 'body'")) data = { text: added() ? '测试书名' : '空书单' };
        else if (command.endsWith("'snapshot' '-i'")) { remote.snapshots++; data = { snapshot: 'textbox 书名 [ref=e1]\nbutton 添加 [ref=e2]',
          refs: { e1: { role: 'textbox', name: '书名' }, e2: { role: 'button', name: '添加' } } }; }
        else if (command.includes(CLICK_ADD)) remote.clicks++;
        stdoutTail = JSON.stringify({ success: true, data });
      }
      return { id: randomUUID(), interrupt: async () => {}, wait: async () => ({ exitCode: 0, stdoutTail, stderrTail: '' }) };
    } };
  const events: ProbeEvent[] = [];
  const input: Parameters<typeof runReview>[0] = { binding, sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), source, sources,
    artifacts: createArtifactStore({ url: 'http://fixture.invalid', secret: 'fixture', objects }),
    handoff: { runId: binding.runId, fromRoleRunId: randomUUID(), toRole: 'reviewer', attempt: 0, baseRevisionId: null,
      expectedRevisionId: binding.revisionId, sourceHash: binding.sourceHash, plan, task: '检查新增书籍', artifactIds: [] },
    sandboxConfig: { baseUrl: 'http://fixture.invalid', apiKey: 'fixture', image: 'fixture' },
    // A transport that would be counted the moment a provider request happened.
    modelConfig: { provider: 'fixture', id: 'fixture', api: 'openai-completions', baseUrl: 'https://model-fixture.invalid/v1',
      apiKey: 'fixture-key', fetch: async () => { remote.modelCalls++; throw new Error('the scripted layer must not call a model'); },
      supportsImages: true },
    signal: new AbortController().signal, assertActive: async () => {}, onLeaseRenewed: async () => {},
    onEvent: async (event) => { events.push(event); } };
  const boundaries = { sandboxConnector: { create: async () => connection, connect: async () => connection },
    previewFetch: async () => new Response(JSON.stringify({ revisionId: source.revisionId, sourceHash: source.sourceHash })) };
  return { input, boundaries, remote, events };
}

const scriptedPlan: Plan = { schemaVersion: 1, goal: '新增书籍', changeSummary: '新增书籍', assumptions: [], outOfScope: [],
  behaviors: [{ id: 'B01', title: '添加书籍', precondition: '空书单', action: '点击添加按钮并查看列表', expected: '出现测试书名', required: true,
    steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: '添加' }, { type: 'capture' }],
    assertions: [{ kind: 'text', text: '测试书名', negated: false }] }] };

test('a compiled plan is accepted through finishReview without a single provider request', async () => {
  const f = await fixture(scriptedPlan);
  const { receipt } = await runReview(f.input, f.boundaries);
  assertVerifiedReviewReceipt(receipt);
  expect(receipt.markerVerified).toBe(true);
  expect(receipt.chromeClosed).toBe(true);
  // The point of the layer: no provider request happened, and the browser really
  // performed the plan's click.
  expect(f.remote.modelCalls).toBe(0);
  expect(f.remote.clicks).toBe(1);
  const item = receipt.result.items[0];
  expect(item).toMatchObject({ behaviorId: 'B01', verdict: 'passed', expected: '出现测试书名' });
  // Every id the item cites must be resolvable in the very evidence that is
  // persisted, and every artifact id in the stored artifacts.
  const evidenceIds = new Set(receipt.evidence.map((event) => event.id));
  expect(item.observationEventIds).toHaveLength(2);
  expect(item.observationEventIds.every((id) => evidenceIds.has(id))).toBe(true);
  expect(item.screenshotIds).toHaveLength(1);
  // finishReview requires exactly this storage key shape for each artifact.
  for (const artifact of receipt.artifacts)
    expect(artifact.key).toBe(`${f.input.source.ownerId}/${f.input.source.projectId}/${f.input.source.revisionId}/checks/${artifact.id}.png`);
  expect(receipt.evidence.map((event) => event.action)).toEqual([null, 'click']);
}, 20_000);

test('the scripted pass renews the run lease with a trusted completion bound to the reviewer role run', async () => {
  const f = await fixture(scriptedPlan);
  const { receipt } = await runReview(f.input, f.boundaries);
  expect(receipt.result.items[0].verdict).toBe('passed');
  // review.ts binds the emitting role, so the kernel's own event needs no role id;
  // what matters is that a trusted completion is observable per compiled program
  // and that the tool name is on the meaningful-progress allowlist.
  const completions = f.events.filter((event) => event.type === 'tool.end' && event.success === true);
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({ toolName: 'browser_steps', success: true });
  expect(completions[0].roleRunId).toBeUndefined();
}, 20_000);

test('a failing scripted assertion ends as a failed verdict, not a checked-and-passed candidate', async () => {
  const failing: Plan = { ...scriptedPlan, behaviors: [{ ...scriptedPlan.behaviors[0],
    assertions: [{ kind: 'text', text: '不会出现的文字', negated: false }] }] };
  const f = await fixture(failing);
  const { receipt } = await runReview(f.input, f.boundaries);
  expect(f.remote.modelCalls).toBe(0);
  expect(receipt.result.items[0]).toMatchObject({ verdict: 'failed' });
  expect(receipt.result.items[0].actual).toContain('未出现');
}, 20_000);

test('a REVIEW_TIMEOUT from the check stays a typed failure instead of a generic blocked receipt', async () => {
  const f = await fixture(scriptedPlan);
  let providerCalls = 0;
  f.input.modelConfig.fetch = async () => { providerCalls++; throw new Error('the scripted layer must not call a model'); };
  // The wall-clock gate aborts the owning Run with this reason mid-check; the
  // scripted layer must pass the typed timeout through instead of swallowing it
  // into a receipt whose error_code would read as a generic CHECK_BLOCKED.
  const abort = new AbortController();
  f.input.signal = abort.signal;
  f.input.onEvent = async (event) => { f.events.push(event);
    if (event.toolName === 'browser_steps' && event.type === 'tool.end')
      abort.abort(new RuntimeError('REVIEW_TIMEOUT', '本次检查超过验收时间上限')); };
  await expect(runReview(f.input, f.boundaries)).rejects.toMatchObject({ code: 'REVIEW_TIMEOUT' });
  expect(providerCalls).toBe(0);
}, 20_000);

test('a partially compilable plan keeps the scripted verdict and blocks only the unexecutable behaviour', async () => {
  const compiledBehavior = scriptedPlan.behaviors[0];
  const partial: Plan = { ...scriptedPlan, behaviors: [compiledBehavior,
    // A prose-only behaviour: nothing the script can drive. It used to send the whole check back to the
    // model path, discarding the compiled behaviour's real verdict; it is now blocked with its reason.
    { ...compiledBehavior, id: 'B02', title: '拖拽排序', steps: undefined, assertions: undefined }] };
  const f = await fixture(partial);
  const { receipt } = await runReview(f.input, f.boundaries);
  assertVerifiedReviewReceipt(receipt);
  // The measured regression this replaces: 35 compiled behaviours were re-done by the model because 4
  // could not compile. Here the compiled verdict survives, the unexecutable behaviour is blocked, and
  // the provider transport is never reached.
  expect(f.remote.modelCalls).toBe(0);
  expect(f.events.filter((event) => event.toolName === 'replay_fallback')).toHaveLength(0);
  expect(receipt.result.items).toMatchObject([
    { behaviorId: 'B01', verdict: 'passed', expected: '出现测试书名' },
    { behaviorId: 'B02', verdict: 'blocked', expected: '出现测试书名' },
  ]);
  // blocked names the planning gap and cites no evidence: fail-closed is unchanged, so `finishReview`
  // records the check as blocked rather than accepting the candidate.
  expect(String(receipt.result.items[1].actual)).toContain('missing-steps');
  expect(receipt.result.items[1].observationEventIds).toEqual([]);
  // The compiled behaviour really performed the plan's click; the unexecutable one drove nothing.
  expect(f.remote.clicks).toBe(1);
}, 20_000);

test('a plan where nothing compiles still falls back to the model path as a whole', async () => {
  const proseOnly: Plan = { ...scriptedPlan, behaviors: [
    { ...scriptedPlan.behaviors[0], id: 'B01', steps: undefined, assertions: undefined }] };
  const f = await fixture(proseOnly);
  // The provider is unavailable on purpose: a provider request at all is what proves the fallback
  // happened, and how that request fails is the model path's own business. The run is stopped from the
  // fallback event, so the test does not spend a model retry window proving a point already made.
  const controller = new AbortController();
  f.input.signal = controller.signal;
  let calls = 0;
  f.input.modelConfig.fetch = async () => { calls++; throw new Error('provider fixture unavailable'); };
  f.input.onEvent = async (event) => { f.events.push(event);
    if (event.toolName === 'replay_fallback') controller.abort('CANCELLED'); };
  // Reaching the model path is what rejects here: with nothing compiled there is no deterministic
  // verdict to keep, so the whole check is handed over rather than assembled from blocked items.
  await expect(runReview(f.input, f.boundaries)).rejects.toMatchObject({ code: 'CANCELLED' });
  const fallback = f.events.filter((event) => event.toolName === 'replay_fallback');
  expect(fallback).toHaveLength(1);
  expect(fallback[0].message).toContain('B01:missing-steps');
  // No provider request came from the scripted layer, and the page was never driven: the model path
  // starts from the preview this layer left untouched.
  expect(calls).toBe(0);
  expect(f.remote.clicks).toBe(0);
}, 20_000);

/**
 * The appearance judge is the one provider call a visual plan may make, so its answer is a plain text
 * completion with no tool calls. The stub also records the request bodies: the only way to show the
 * judge saw the pixels is that the captured image went out on the wire.
 */
function judgeCompletion(text: string) {
  const chunk = { id: 'judge-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

/** The same plan shape as `scriptedPlan`, but its verdict lives in the pixels rather than the DOM. */
const visualScriptedPlan: Plan = { ...scriptedPlan, behaviors: [{ ...scriptedPlan.behaviors[0],
  action: '查看首屏账单区域', expected: '结算区域显示金额 12.00 且靠右对齐', evidence: 'visual',
  steps: [{ type: 'open', path: '/' }, { type: 'capture' }],
  assertions: [{ kind: 'text', text: '空书单', negated: false }] }] };

test('an appearance behaviour is judged from the captured image and the check is accepted', async () => {
  const f = await fixture(visualScriptedPlan);
  const bodies: string[] = [];
  f.input.modelConfig.fetch = async (_url, init) => {
    f.remote.modelCalls++;
    bodies.push(String(init?.body ?? ''));
    return judgeCompletion(JSON.stringify({ judgements: [{ id: 'B01', verdict: 'passed',
      citation: '账单区域显示 12.00，且与右边缘对齐' }] }));
  };
  const { receipt } = await runReview(f.input, f.boundaries);
  assertVerifiedReviewReceipt(receipt);
  const item = receipt.result.items[0];
  expect(item).toMatchObject({ behaviorId: 'B01', verdict: 'passed', expected: visualScriptedPlan.behaviors[0].expected });
  // One request judged the appearance behaviour, and it carried the pixels the kernel captured. The
  // judge never receives a browser, so those pixels are the only thing it can have looked at.
  expect(f.remote.modelCalls).toBe(1);
  expect(bodies[0]).toContain(PNG_BASE64);
  expect(bodies[0]).toContain(visualScriptedPlan.behaviors[0].expected);
  // The gates `finishReview` applies to this item, asserted against the receipt it will receive.
  const evidenceIds = new Set(receipt.evidence.map((event) => event.id));
  expect(item.observationEventIds.length).toBeGreaterThan(0);
  expect(item.observationEventIds.every((id) => evidenceIds.has(id))).toBe(true);
  const artifacts = new Map(receipt.artifacts.map((artifact) => [artifact.id, artifact]));
  expect(item.screenshotIds).toHaveLength(1);
  for (const id of item.screenshotIds) {
    expect(artifacts.has(id)).toBe(true);
    expect(artifacts.get(id)!.key).toBe(
      `${f.input.source.ownerId}/${f.input.source.projectId}/${f.input.source.revisionId}/checks/${id}.png`);
  }
  // A real observation plus the captured image is the render evidence a non-blocked item needs.
  expect(allowsRenderOnlyEvidence(visualScriptedPlan.behaviors[0])).toBe(true);
}, 20_000);

test('a model without verified vision never receives the captured image', async () => {
  const f = await fixture(visualScriptedPlan);
  f.input.modelConfig.supportsImages = false;
  const { receipt } = await runReview(f.input, f.boundaries);
  assertVerifiedReviewReceipt(receipt);
  // The platform's capability gate keeps the pixels on this side: a model that failed the vision
  // probe is never asked, so it cannot guess its way to a citation, and the check ends blocked
  // rather than accepted. This is the honest shape of a real run on the configured model today.
  expect(f.remote.modelCalls).toBe(0);
  expect(receipt.result.items[0]).toMatchObject({ behaviorId: 'B01', verdict: 'blocked' });
}, 20_000);

test('a visual program failure keeps the completed deterministic check and its evidence', async () => {
  const plan: Plan = { ...scriptedPlan, behaviors: [scriptedPlan.behaviors[0],
    { ...visualScriptedPlan.behaviors[0], id: 'B02',
      steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: 'Missing control' }, { type: 'capture' }] }] };
  const f = await fixture(plan);
  const { receipt } = await runReview(f.input, f.boundaries);
  assertVerifiedReviewReceipt(receipt);
  expect(receipt.markerVerified).toBe(true);
  expect(receipt.result.items).toMatchObject([
    { behaviorId: 'B01', verdict: 'passed' },
    { behaviorId: 'B02', verdict: 'blocked' },
  ]);
  expect(receipt.result.items[1].actual).toContain('STALE_BROWSER_REF');
  const evidenceIds = new Set(receipt.evidence.map((event) => event.id));
  expect(receipt.result.items[0].observationEventIds.length).toBeGreaterThan(0);
  expect(receipt.result.items[0].observationEventIds.every((id) => evidenceIds.has(id))).toBe(true);
  expect(f.events.filter((event) => event.toolName === 'replay_fallback')).toHaveLength(0);
}, 20_000);

test('the production review resolves a predicted control name against the actual page controls', async () => {
  const f = await fixture({ ...scriptedPlan, behaviors: [{ ...scriptedPlan.behaviors[0],
    steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: '新增书籍' }] }] });
  f.input.modelConfig.fetch = async () => { f.remote.modelCalls++; return judgeCompletion('e2'); };
  const budget = createRunTokenBudget(100_000);
  f.input.tokenBudget = budget;
  const { receipt, usage } = await runReview(f.input, f.boundaries);
  expect(receipt.result.items[0].verdict).toBe('passed');
  expect(f.remote.modelCalls).toBe(1);
  expect(f.remote.clicks).toBe(1);
  expect(usage).toMatchObject({ modelCalls: 1, input: 10, output: 5, total: 15 });
  expect(budget.snapshot()).toMatchObject({ requests: 1, pendingRequests: 0, accountedTokens: 15 });
}, 20_000);

test('one production deadline retains completed checks and marks the remaining scope not run', async () => {
  const f = await fixture({ ...scriptedPlan, behaviors: [scriptedPlan.behaviors[0],
    { ...scriptedPlan.behaviors[0], id: 'B02' }] });
  let now = 0;
  f.input.onEvent = async (event) => {
    f.events.push(event);
    if (event.toolName === 'browser_steps' && event.type === 'tool.end') now = 570_001;
  };
  const { receipt, usage } = await runReview(f.input, { ...f.boundaries, monotonicNow: () => now });
  expect(receipt.result.items).toMatchObject([
    { behaviorId: 'B01', verdict: 'passed' },
    { behaviorId: 'B02', verdict: 'blocked', actual: expect.stringContaining('REVIEW_TIMEOUT') },
  ]);
  expect(receipt.markerVerified).toBe(true);
  expect(receipt.evidence.length).toBeGreaterThan(0);
  expect(f.remote.clicks).toBe(1);
  expect(usage?.elapsedMs).toBe(570_001);
}, 20_000);

test('a visual program without initial observation is rejected before browser or model work', async () => {
  const f = await fixture({ ...visualScriptedPlan, behaviors: [{ ...visualScriptedPlan.behaviors[0],
    steps: [{ type: 'resize', width: 390, height: 844 }, { type: 'capture' }] }] });
  const { receipt } = await runReview(f.input, f.boundaries);
  expect(receipt.result.items[0]).toMatchObject({ verdict: 'blocked', actual: expect.stringContaining('invalid-setup') });
  expect(f.remote.snapshots).toBe(0);
  expect(f.remote.modelCalls).toBe(0);
  expect(f.events.filter((event) => event.toolName === 'replay_fallback')).toHaveLength(0);
}, 20_000);

test('visual inference gets only the remaining shared time and retains earlier checks when it stalls', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const f = await fixture({ ...scriptedPlan, behaviors: [scriptedPlan.behaviors[0],
      { ...visualScriptedPlan.behaviors[0], id: 'B02', assertions: [{ kind: 'text', text: '测试书名', negated: false }] }] });
    let advanced = false;
    f.input.onEvent = async (event) => {
      // Spend preparation/execution time once. Visual capture now correctly emits
      // its own progress event and must not charge the fixture's elapsed time twice.
      if (!advanced && event.toolName === 'browser_steps' && event.type === 'tool.end') {
        advanced = true;
        vi.advanceTimersByTime(560_000);
      }
    };
    let calls = 0;
    f.input.modelConfig.fetch = async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    };
    const pending = runReview(f.input, f.boundaries);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_001);
    const { receipt, usage } = await pending;
    expect(receipt.result.items.map(item => item.verdict)).toEqual(['passed', 'blocked']);
    expect(receipt.verification?.timedOut).toBe(true);
    expect(usage?.modelCalls).toBe(1);
    expect(usage?.elapsedMs).toBeLessThanOrEqual(570_001);
  } finally { vi.useRealTimers(); }
}, 20_000);

test('the shared deadline also bounds a stalled sandbox connection before any checks start', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const f = await fixture(scriptedPlan);
    f.boundaries.sandboxConnector.connect = () => new Promise(() => {});
    const pending = runReview(f.input, f.boundaries);
    const completion = pending.then(() => true, () => true);
    await vi.advanceTimersByTimeAsync(570_001);
    expect(await Promise.race([completion, Promise.resolve(false)])).toBe(true);
    const { receipt } = await pending;
    expect(receipt.verification?.timedOut).toBe(true);
    expect(receipt.result.items[0].verdict).toBe('blocked');
    expect(receipt.result.items[0].actual).toContain('验收时间上限');
    expect(f.remote.modelCalls).toBe(0);
  } finally { vi.useRealTimers(); }
});

test('user cancellation after a completed item returns no review receipt', async () => {
  const f = await fixture({ ...scriptedPlan, behaviors: [scriptedPlan.behaviors[0],
    { ...scriptedPlan.behaviors[0], id: 'B02' }] });
  const controller = new AbortController();
  f.input.signal = controller.signal;
  f.input.onEvent = async (event) => {
    if (event.toolName === 'browser_steps' && event.type === 'tool.end') controller.abort('CANCELLED');
  };
  await expect(runReview(f.input, f.boundaries)).rejects.toMatchObject({code:'CANCELLED'});
  expect(f.remote.clicks).toBe(1);
});

test('an unpredictable screenshot-store failure preserves the earlier item within declared capacity', async () => {
  // Both programs are statically admissible (one capture each). A known
  // 124-capture plan belongs in admission, not a runtime partial-failure test.
  const behavior = scriptedPlan.behaviors[0];
  const f=await fixture({...scriptedPlan,behaviors:[behavior,{...behavior,id:'B02'}]});
  const save = f.input.artifacts.save.bind(f.input.artifacts);
  let saves = 0;
  f.input.artifacts = { ...f.input.artifacts, save: async (...args) => {
    if (++saves === 2) throw new RuntimeError('ARTIFACT_UNAVAILABLE', 'Unexpected storage outage');
    return save(...args);
  } };
  const {receipt}=await runReview(f.input,f.boundaries);
  expect(receipt.result.items[0].verdict).toBe('passed');
  expect(receipt.result.items[1]).toMatchObject({verdict:'blocked',actual:expect.stringContaining('ARTIFACT_UNAVAILABLE')});
  expect(receipt.artifacts).toHaveLength(1);
  expect(receipt.result.items[0].screenshotIds).toEqual([receipt.artifacts[0].id]);
  assertVerifiedReviewReceipt(receipt);
});

test('the hard deadline remains armed during the last ownership check after Chrome cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const f=await fixture(scriptedPlan);
    const connection=await f.boundaries.sandboxConnector.connect();
    let released=false;
    connection.close=async()=>{released=true;};
    f.input.assertActive=async()=>{if(released)await new Promise(()=>{});};
    const pending=runReview(f.input,f.boundaries);
    const completion=pending.then(()=>true,()=>true);
    await vi.advanceTimersByTimeAsync(600_001);
    expect(await Promise.race([completion,Promise.resolve(false)])).toBe(true);
    await expect(pending).rejects.toMatchObject({code:'REVIEW_TIMEOUT'});
  }finally{vi.useRealTimers();}
});
