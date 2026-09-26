import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Plan } from '@pivloom/contracts';
import { createSourceStore } from '../../src/storage/source.js';
import { createArtifactStore } from '../../src/storage/artifacts.js';
import { createSourceSnapshot } from '../../src/runtime/snapshot.js';
import { runReview, assertVerifiedReviewReceipt } from '../../src/generation/review.js';
import type { ProbeEvent } from '../../src/runtime/types.js';
import { RuntimeError } from '../../src/runtime/types.js';
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

test('a partially compilable plan runs the scripted behaviour, then falls back to the model path', async () => {
  const compiledBehavior = scriptedPlan.behaviors[0];
  const partial: Plan = { ...scriptedPlan, behaviors: [compiledBehavior,
    // A prose-only behaviour: nothing the script can drive, so the report cannot
    // be assembled by this layer and the model path must take over entirely.
    { ...compiledBehavior, id: 'B02', title: '拖拽排序', steps: undefined, assertions: undefined }] };
  const f = await fixture(partial, { added: () => true });
  // The provider is unavailable on purpose: a provider request at all is what
  // proves the fallback happened, and how that request fails is the model path's
  // own business. The run is stopped from the emitted progress event, so the
  // test does not spend a model retry window proving a point already made.
  const controller = new AbortController();
  f.input.signal = controller.signal;
  let calls = 0;
  let sawScriptedProgress = false;
  f.input.modelConfig.fetch = async () => { calls++; throw new Error('provider fixture unavailable'); };
  f.input.onEvent = async (event) => { f.events.push(event);
    if (event.toolName === 'browser_steps' && event.type === 'tool.end') { sawScriptedProgress = true; controller.abort('CANCELLED'); } };
  await expect(runReview(f.input, f.boundaries)).rejects.toMatchObject({ code: 'CANCELLED' });
  const fallback = f.events.filter((event) => event.toolName === 'replay_fallback');
  expect(fallback).toHaveLength(1);
  expect(fallback[0].message).toContain('B02:missing-steps');
  // The compiled half really ran the browser before falling back, its trusted
  // completion events were emitted, and no provider request came from this layer.
  expect(f.remote.clicks).toBe(1);
  expect(sawScriptedProgress).toBe(true);
  expect(calls).toBe(0);
}, 20_000);
