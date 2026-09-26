import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { runReviewer, type ReviewBrowser } from '../../src/runtime/reviewer.js';
import type { ModelConfig, ProbeEvent } from '../../src/runtime/types.js';
import { createMeaningfulProgressGate } from '../../src/generation/progress-watchdog.js';
import {
  REPLAY_WALL_CLOCK_BUDGET_MS, REVIEW_SUBMISSION_RESERVE_MS, REVIEW_WALL_CLOCK_BUDGET_MS, VERIFICATION_WALL_CLOCK_LIMIT_MS,
} from '../../src/runtime/budgets.js';

/**
 * Wall-clock ceiling coverage, kept in its own file because the reviewer test
 * file is scripted turn by turn and shared with another workstream. Everything
 * below is real Pi loop, real evidence validation and the same external fixtures
 * `reviewer.test.ts` uses; only the monotonic clock is injected, so no test waits
 * eight real minutes and none depends on scheduling.
 */

const revisionId = randomUUID(), sourceHash = 'a'.repeat(64);
const plan = { schemaVersion: 1 as const, goal: '新增书籍', changeSummary: '新增书籍', assumptions: [], outOfScope: ['不发送邮件'],
  behaviors: [{ id: 'B01', title: '添加', precondition: '空书单', action: '填写并添加', expected: '出现书名', required: true }] };
type ToolChoice = { name: string; args: unknown };

function setup(turn: (request: { messages: Array<{ role: string; content: string }> }, n: number) => ToolChoice | ToolChoice[]) {
  let calls = 0, actions = 0, closes = 0;
  const observation = () => ({ id: randomUUID(), sessionId: 'pivloom-'+revisionId, url:'http://127.0.0.1:4173/', tree:'button 添加 [ref=e1]', text: actions ? '测试书名' : '空书单', refs:{ e1:{ role:'button', name:'添加' } }, truncated: false });
  const browser: ReviewBrowser = { sessionId:'pivloom-'+revisionId, open:async()=>observation(), observe:async()=>observation(),
    resize:async(width,height)=>({...observation(),text:`[viewport] width=${width} height=${height} scrollWidth=${width}\n测试书名`}),
    act:async()=>{actions++; return observation();}, logs:async()=>({errors:[]}), close:async()=>{closes++; return {confirmed:true};},
    screenshot:async()=>({base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0KAAAAABJRU5ErkJggg==',sha256:'b'.repeat(64),mimeType:'image/png'}) };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const choices = turn(JSON.parse(String(init?.body)), ++calls);
    const toolCalls = (Array.isArray(choices) ? choices : [choices]).map((choice,index)=>({index,id:`call-${calls}-${index}`,type:'function',function:{name:choice.name,arguments:JSON.stringify(choice.args)}}));
    const chunk = { id:'fixture-'+calls,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',reasoning_content:'PRIVATE_HIDDEN_REASONING',tool_calls:toolCalls},finish_reason:null}] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const runId = randomUUID(),roleRunId=randomUUID();
  const modelConfig: ModelConfig & {fetch: typeof globalThis.fetch} = {provider:'review-fixture',id:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',apiKey:'private-review-key',fetch,supportsImages:true};
  const input = { binding:{runId,roleRunId,attempt:0,revisionId,sourceHash,sandboxId:'fixture-sandbox',browserSessionId:browser.sessionId},
    sessionId:randomUUID(), handoff:{runId,fromRoleRunId:randomUUID(),toRole:'reviewer' as const,attempt:0,baseRevisionId:null,expectedRevisionId:revisionId,sourceHash,plan,task:'检查新增书籍',artifactIds:[]},
    browser,files:[{path:'src/App.tsx',content:'export default function App() {}'}],modelConfig,
    signal:new AbortController().signal,assertActive:async()=>{},requireVisionEvidence:false,
    saveScreenshot:async()=>({id:randomUUID(),mimeType:'image/png' as const,sha256:'b'.repeat(64)}) };
  return { input, stats:()=>({calls,actions,closes}) };
}
const report=(ids:string[])=>({revisionId,sourceHash,items:[{behaviorId:'B01',verdict:'passed',expected:'出现书名',actual:'已出现',observationEventIds:ids,screenshotIds:[],reproSteps:['点击添加']}],summary:'通过'});
const toolData = (request: { messages: Array<{ role: string; content: string }> }) =>
  JSON.parse(request.messages.filter((message) => message.role === 'tool').at(-1)?.content ?? 'null');

test('the verification ceiling splits cleanly and leaves room for a forced submission',()=>{
  expect(VERIFICATION_WALL_CLOCK_LIMIT_MS).toBe(600_000);
  expect(REPLAY_WALL_CLOCK_BUDGET_MS + REVIEW_WALL_CLOCK_BUDGET_MS).toBe(VERIFICATION_WALL_CLOCK_LIMIT_MS);
  expect(REVIEW_WALL_CLOCK_BUDGET_MS).toBe(480_000);
  expect(REVIEW_SUBMISSION_RESERVE_MS).toBeGreaterThan(0);
  expect(REVIEW_SUBMISSION_RESERVE_MS).toBeLessThan(REVIEW_WALL_CLOCK_BUDGET_MS);
});

test('the budget stop notice cannot renew the run inactivity lease',()=>{
  const meaningfulProgress = createMeaningfulProgressGate();
  expect(meaningfulProgress(randomUUID(), { type:'tool.end', toolName:'review_wall_clock', success:true, message:'检查者因墙钟上限被停止' })).toBe(false);
});

test('a check whose model keeps making progress is stopped by the wall-clock ceiling as REVIEW_TIMEOUT',async()=>{
  let elapsedMs = 0;
  // Every turn succeeds and produces a real tool result, so this is progress and
  // not inactivity: only a cumulative ceiling can stop it.
  const f = setup(()=>{ elapsedMs += 200_000; return { name:'source_read', args:{ path:'src/App.tsx' } }; });
  await expect(runReviewer({ ...f.input, monotonicNow:()=>elapsedMs, maxToolCalls:12 }))
    .rejects.toMatchObject({ code:'REVIEW_TIMEOUT', message:expect.stringContaining('墙钟上限') });
  // The third turn is where 600s of injected progress crosses the 480s ceiling.
  expect(f.stats()).toEqual({ calls:3, actions:0, closes:1 });
});

test('a wall-clock stop is recorded as a structured, non-progress event in the run record',async()=>{
  let elapsedMs = 0;
  const events: ProbeEvent[] = [];
  const f = setup(()=>{ elapsedMs += 250_000; return { name:'source_read', args:{ path:'src/App.tsx' } }; });
  await expect(runReviewer({ ...f.input, monotonicNow:()=>elapsedMs, maxToolCalls:12,
    onEvent:async(event)=>{ events.push(event); } })).rejects.toMatchObject({ code:'REVIEW_TIMEOUT' });
  expect(events).toContainEqual(expect.objectContaining({ type:'tool.end', toolName:'review_wall_clock', success:false,
    message:expect.stringContaining('REVIEW_TIMEOUT') }));
  expect(events.filter(event=>event.toolName==='review_wall_clock').map(event=>event.success)).toEqual([false]);
});

test('a check that finishes inside the ceiling is unaffected',async()=>{
  let elapsedMs = 0;
  const f = setup((request,n)=>{
    elapsedMs += 20_000;
    const data = toolData(request);
    if(n===1)return { name:'browser_open', args:{} };
    if(n===2)return { name:'browser_click', args:{ behaviorId:'B01', observationId:data.observationId, ref:'e1' } };
    return { name:'submit_review', args:report([data.id]) };
  });
  const result = await runReviewer({ ...f.input, monotonicNow:()=>elapsedMs });
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats()).toEqual({ calls:3, actions:1, closes:1 });
  expect(elapsedMs).toBeLessThan(REVIEW_WALL_CLOCK_BUDGET_MS);
});

test('inside the submission reserve the check stops collecting evidence and submits instead of overrunning',async()=>{
  let elapsedMs = 0, actionEventId = '', screenshots = 0, screenshotsWhenSubmitting = -1;
  const f = setup((request,n)=>{
    const data = toolData(request);
    if(n===1)return { name:'browser_open', args:{} };
    if(n===2)return { name:'browser_click', args:{ behaviorId:'B01', observationId:data.observationId, ref:'e1' } };
    if(n===3){
      // Cross into the reserve only after a real action was collected, so the
      // refused call is genuinely evidence that can no longer fit in the budget.
      elapsedMs = REVIEW_WALL_CLOCK_BUDGET_MS - 30_000;
      actionEventId = data.id;
      return { name:'browser_screenshot', args:{} };
    }
    screenshotsWhenSubmitting = screenshots;
    return { name:'submit_review', args:report([actionEventId]) };
  });
  const capture = f.input.browser.screenshot;
  f.input.browser.screenshot = async () => { screenshots++; return capture(); };
  const events: ProbeEvent[] = [];
  const result = await runReviewer({ ...f.input, monotonicNow:()=>elapsedMs, onEvent:async(event)=>{ events.push(event); } });
  // The forced submission produced a real report from the evidence already held.
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats().actions).toBe(1);
  expect(elapsedMs).toBeLessThan(REVIEW_WALL_CLOCK_BUDGET_MS);
  // The evidence call was refused, reported as unsuccessful, and never reached
  // the browser: collection stopped instead of running over the ceiling. The one
  // later capture is the service's own artifact for the decided report.
  expect(screenshotsWhenSubmitting).toBe(0);
  expect(screenshots).toBe(1);
  expect(events).toContainEqual(expect.objectContaining({ type:'tool.end', toolName:'browser_screenshot', success:false,
    message:expect.stringContaining('REVIEW_SUBMISSION_REQUIRED') }));
  const screenshotTurns = events.filter(event=>event.type==='tool.end'&&event.toolName==='browser_screenshot');
  expect(screenshotTurns.map(event=>event.success)).toEqual([false]);
});

test('the owning review can retain fully evidenced model checkpoints after its shared deadline', async () => {
  let now = 0;
  const f = setup((request, n) => {
    const data = toolData(request);
    if (n === 1) return { name: 'browser_open', args: {} };
    if (n === 2) return { name: 'browser_click', args: { behaviorId: 'B01', observationId: data.observationId, ref: 'e1' } };
    if (n === 3) return { name: 'record_behavior', args: report([data.id]).items[0] };
    now = 300_001;
    return { name: 'source_read', args: { path: 'src/App.tsx' } };
  });
  f.input.handoff.plan.behaviors.push({ ...plan.behaviors[0], id: 'B02' });
  try {
    const result = await runReviewer({ ...f.input, monotonicNow: () => now, deadlineAt: 300_000,
      preservePartialOnTimeout: true });
    expect(result.result.items).toMatchObject([
      { behaviorId: 'B01', verdict: 'passed' },
      { behaviorId: 'B02', verdict: 'blocked', actual: expect.stringContaining('REVIEW_TIMEOUT') },
    ]);
    expect(result.evidence.length).toBeGreaterThan(0);
  } finally { f.input.handoff.plan.behaviors.pop(); }
});

test('a later browser failure preserves fully evidenced model checkpoints without completing the review', async () => {
  const f = setup((request, n) => {
    const data = toolData(request);
    if (n === 1) return { name: 'browser_open', args: {} };
    if (n === 2) return { name: 'browser_click', args: { behaviorId: 'B01', observationId: data.observationId, ref: 'e1' } };
    if (n === 3) return { name: 'record_behavior', args: report([data.id]).items[0] };
    return { name: 'browser_observe', args: {} };
  });
  f.input.handoff.plan.behaviors.push({ ...plan.behaviors[0], id: 'B02' });
  f.input.browser.observe = async () => { throw new Error('browser fixture disconnected'); };
  try {
    const result = await runReviewer({ ...f.input, preservePartialOnFailure: true });
    expect(result.result.items.map(item => item.verdict)).toEqual(['passed', 'blocked']);
    expect(result.incompleteReason).toBe('REVIEWER_TOOL_FAILED');
    expect(result.evidence.length).toBeGreaterThan(0);
  } finally { f.input.handoff.plan.behaviors.pop(); }
});
