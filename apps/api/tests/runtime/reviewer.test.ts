import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { allowsRenderOnlyEvidence } from '@pivloom/contracts';
import { runReviewer, assertReviewerResult, deliveredScreenshotIdsFromRequest, type ReviewBrowser } from '../../src/runtime/reviewer.js';
import { RuntimeError, type ModelConfig, type ProbeEvent } from '../../src/runtime/types.js';
import { classifyReviewerModelFailure } from '../../src/runtime/reviewer.js';
import { MODEL_REQUEST_TIMEOUT_MS, PROVIDER_RETRY_POLICY, RUN_IDLE_TIMEOUT_MS, SANDBOX_LEASE_SEGMENT_MS } from '../../src/runtime/budgets.js';

test('a single provider request is bounded below the renewable inactivity and sandbox leases',()=>{
  expect(MODEL_REQUEST_TIMEOUT_MS).toBeGreaterThan(57_000);
  expect(MODEL_REQUEST_TIMEOUT_MS).toBeLessThan(RUN_IDLE_TIMEOUT_MS);
  expect(RUN_IDLE_TIMEOUT_MS).toBeLessThan(SANDBOX_LEASE_SEGMENT_MS);
});

test('a failed provider request is classified independently of elapsed Reviewer time',()=>{
  const timeout=classifyReviewerModelFailure({errorMessage:'Request timed out after 120s'});
  expect(timeout.code).toBe('MODEL_REQUEST_TIMEOUT');
  const other=classifyReviewerModelFailure({errorMessage:'Provider returned a malformed payload'});
  expect(other.code).toBe('MODEL_FAILED');
});

// External model HTTP and browser protocol fixtures; actual Pi loop, permission
// allowlist and evidence validation execute without mocking internal modules.
const revisionId = randomUUID(), sourceHash = 'a'.repeat(64);
const plan = { schemaVersion: 1 as const, goal: '新增书籍', changeSummary: '新增书籍', assumptions: [], outOfScope: ['不发送邮件'],
  behaviors: [{ id: 'B01', title: '添加', precondition: '空书单', action: '填写并添加', expected: '出现书名', required: true }] };
type ToolChoice = { name: string; args: unknown };
function setup(turn: (request: { messages: Array<{ role: string; content: string }> }, n: number) => ToolChoice | ToolChoice[], usageForCall: (n: number) => { prompt_tokens: number; completion_tokens: number; total_tokens: number } = () => ({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })) {
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
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:usageForCall(calls)})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
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
test('a scenario checks two behaviors with fresh controls and delivered checkpoint images in three model turns',async()=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_steps',args:{observationId:data.observationId,steps:[
      {type:'click',role:'button',name:'添加',behaviorIds:['B01'],capture:true},
      {type:'press',key:'2',behaviorIds:['B02']},
      {type:'press',key:'Enter',behaviorIds:['B02'],capture:true},
    ]}};
    const checkpoints=data.checkpoints.filter((item:{artifactId?:string})=>item.artifactId);
    return {name:'submit_review',args:{revisionId,sourceHash,summary:'两个真实场景已检查',items:checkpoints.map((item:{artifactId:string;evidence:Array<{behaviorId:string;reportEvidenceId:string}>})=>({
      behaviorId:item.evidence[0].behaviorId,verdict:'passed',expected:'出现书名',actual:'已实际操作并观察结果',
      observationEventIds:[item.evidence[0].reportEvidenceId],screenshotIds:[item.artifactId],reproSteps:['执行真实控件操作并查看结果截图'],
    }))}};
  });
  f.input.handoff.plan={...plan,behaviors:[plan.behaviors[0],{...plan.behaviors[0],id:'B02',title:'键盘输入'}]};
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(result.result.items.map(item=>item.verdict)).toEqual(['passed','passed']);
  expect(result.evidence.map(item=>item.behaviorId)).toEqual([null,'B01','B02','B02']);
  expect(f.stats()).toEqual({calls:3,actions:3,closes:1});
});

test('a real timed observation supplies motion evidence without inventing a click',async()=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_steps',args:{observationId:data.observationId,steps:[{type:'wait',ms:1,behaviorIds:['B01'],capture:true}]}};
    const checkpoint=data.checkpoints[0];
    return {name:'submit_review',args:{...report([checkpoint.evidence[0].reportEvidenceId]),items:[{
      ...report([checkpoint.evidence[0].reportEvidenceId]).items[0],screenshotIds:[checkpoint.artifactId],
    }]}};
  });
  f.input.handoff.plan={...plan,behaviors:[{...plan.behaviors[0],action:'等待若干 tick'}]};
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(result.evidence.at(-1)).toMatchObject({action:'wait',behaviorId:'B01'});
  expect(f.stats()).toEqual({calls:3,actions:0,closes:1});
});
test('a fabricated passing report cannot replace actual browser actions and observations',async()=>{
  const f=setup(()=>({name:'submit_review',args:report([randomUUID()])}));
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats()).toEqual({calls:3,actions:0,closes:1});
});

test('real Pi accepts only a report linked to an action and its subsequent observation',async()=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{path:'/'}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    return {name:'submit_review',args:report([data.id])};
  });
  const result=await runReviewer(f.input);
  expect(result.result.items[0].verdict).toBe('passed');
  expect(result.evidence.at(-1)).toMatchObject({behaviorId:'B01',action:'click',text:'测试书名'});
  expect(f.stats()).toEqual({calls:3,actions:1,closes:1});
});

test.each([
  ['首次加载页面，不点击任何按钮',true],
  ['初次打开页面，不按任何键',true],
  ['等待页面加载完成，观察 Canvas 区域与页面文本',true],
  ['观察游戏画布',true],
  ['查看页面文字说明区域',true],
  ['检查页面按钮、输入框和可见控件',true],
  ['游戏进行中不点击重新开始，仅使用方向键和空格',false],
  ['连续按多个方向键',false],
  ['开始游戏并观察画布',false],
  ['观察 Canvas 内容并在开始游戏后观察',false],
  ['在不同窗口大小下目测分数、Canvas、按钮与说明的位置',true],
  ['等待游戏一段时间，观察 Canvas 中蛇是否移动',false],
  ['等待',false],
  ['观察画布后点击开始游戏',false],
  ['观察画布后按键',false],
  ['观察画布后输入数据',false],
  ['观察画布后刷新页面',false],
  ['首次加载页面，不点击任何按钮，随后点击开始游戏',false],
  ['初次打开页面，不按任何键，然后按下空格',false],
])('render-only plan action %s is %s', (action,expected)=>{
  expect(allowsRenderOnlyEvidence({action})).toBe(expected);
});

test.each([
  '首次加载页面，不点击任何按钮',
  '等待页面加载完成，观察 Canvas 区域与页面文本',
])('initial Canvas plan %s can record first-load screenshot without clicking',async action=>{
  let firstEventId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){firstEventId=data.id;return {name:'browser_screenshot',args:{}};}
    return {name:'record_behavior',args:{...report([firstEventId]).items[0],
      screenshotIds:[data.artifactId],reproSteps:['首次加载页面观察初始画面，未点击按钮']}};
  });
  f.input.handoff.plan={...plan,behaviors:[{...plan.behaviors[0],
    action,expected:'Canvas 初始棋盘、分数和说明可见'}]};
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(result.result.items[0].verdict).toBe('passed');
  expect(result.evidence[0]).toMatchObject({behaviorId:null,action:null});
  expect(f.stats()).toEqual({calls:3,actions:0,closes:1});
});

test('layout observation can cite screenshots after two actual browser resizes',async()=>{
  const observationIds:string[]=[],screenshotIds:string[]=[];
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_resize',args:{width:390,height:844}};
    if(n===3){observationIds.push(data.id);return {name:'browser_screenshot',args:{}};}
    if(n===4){screenshotIds.push(data.artifactId);return {name:'browser_resize',args:{width:1280,height:720}};}
    if(n===5){observationIds.push(data.id);return {name:'browser_screenshot',args:{}};}
    screenshotIds.push(data.artifactId);
    return {name:'record_behavior',args:{...report(observationIds).items[0],screenshotIds,
      reproSteps:['390px 截图并观察布局','1280px 截图并观察布局']}};
  });
  f.input.handoff.plan={...plan,behaviors:[{...plan.behaviors[0],
    action:'在不同窗口大小下目测分数、Canvas、按钮与说明的位置',expected:'两种宽度下布局清楚'}]};
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(result.result.items[0].verdict).toBe('passed');
  expect(result.result.items[0].screenshotIds).toHaveLength(2);
  expect(result.evidence.some(event=>event.text.includes('width=390'))).toBe(true);
  expect(result.evidence.some(event=>event.text.includes('width=1280'))).toBe(true);
  expect(f.stats()).toEqual({calls:6,actions:0,closes:1});
});

test('interactive report can correct unbound observation then missing post-action image',async()=>{
  let openedObservationId='',openedEventId='',firstScreenshotId='',clickEventId='';
  const rejected:string[]=[];
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:{observationId?:string;id?:string;artifactId?:string}|null=null;
    try{data=last?JSON.parse(last.content):null;}catch{ /* rejected record is a tool error */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){openedObservationId=String(data?.observationId);openedEventId=String(data?.id);
      return {name:'browser_screenshot',args:{}};}
    if(n===3){firstScreenshotId=String(data?.artifactId);
      return {name:'record_behavior',args:{...report([openedEventId]).items[0],screenshotIds:[firstScreenshotId]}};}
    if(n===4)return {name:'browser_click',args:{behaviorId:'B01',observationId:openedObservationId,ref:'e1'}};
    if(n===5){clickEventId=String(data?.id);
      return {name:'record_behavior',args:{...report([clickEventId]).items[0],screenshotIds:[firstScreenshotId]}};}
    if(n===6)return {name:'browser_screenshot',args:{}};
    return {name:'record_behavior',args:{...report([clickEventId]).items[0],screenshotIds:[String(data?.artifactId)]}};
  });
  const onEvent=async(event:ProbeEvent)=>{
    if(event.type==='tool.end'&&event.toolName==='record_behavior'&&event.success===false)
      rejected.push(event.message);
  };
  const result=await runReviewer({...f.input,requireVisionEvidence:true,onEvent});
  expect(rejected).toHaveLength(2);
  expect(rejected[0]).toContain('OBSERVATION_NOT_BOUND');
  expect(rejected[1]).toContain('IMAGE_EVIDENCE_REQUIRED');
  expect(result.result.items[0].observationEventIds).toEqual([clickEventId]);
  expect(result.result.items[0].screenshotIds).not.toContain(firstScreenshotId);
  expect(f.stats()).toEqual({calls:7,actions:1,closes:1});
});

test('third invalid model turn remains fatal and persists its static rejection code',async()=>{
  const rejected:string[]=[];
  let observationId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){const data=last?JSON.parse(last.content):null;observationId=String(data?.id);}
    return {name:'record_behavior',args:report([observationId]).items[0]};
  });
  const onEvent=async(event:ProbeEvent)=>{
    if(event.type==='tool.end'&&event.toolName==='record_behavior'&&event.success===false)
      rejected.push(event.message);
  };
  await expect(runReviewer({...f.input,onEvent})).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(rejected).toHaveLength(3);
  expect(rejected.every(message=>message.includes('OBSERVATION_NOT_BOUND'))).toBe(true);
  expect(f.stats()).toEqual({calls:4,actions:0,closes:1});
});

test('two unbound records in one model response spend one correction turn, then require a new action',async()=>{
  let observedId='',unboundEventId='';
  const rejected:string[]=[];
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:{observationId?:string;id?:string}|null=null;
    try{data=last?JSON.parse(last.content):null;}catch{ /* rejected reports are tool errors */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_observe',args:{}};
    if(n===3){
      observedId=String(data?.observationId);unboundEventId=String(data?.id);
      const item=report([unboundEventId]).items[0];
      return [{name:'record_behavior',args:item},{name:'record_behavior',args:item}];
    }
    if(n===4)return {name:'browser_click',args:{behaviorId:'B01',observationId:observedId,ref:'e1'}};
    return {name:'record_behavior',args:report([String(data?.id)]).items[0]};
  });
  const onEvent=async (event:ProbeEvent)=>{
    if(event.type==='tool.end'&&event.toolName==='record_behavior'&&event.success===false)
      rejected.push(event.message);
  };
  const result=await runReviewer({...f.input,onEvent});
  expect(rejected).toHaveLength(2);
  expect(rejected.every(message=>message.includes('OBSERVATION_NOT_BOUND'))).toBe(true);
  expect(result.result.items[0]).toMatchObject({behaviorId:'B01',verdict:'passed'});
  expect(result.result.items[0].observationEventIds).not.toContain(unboundEventId);
  expect(f.stats()).toEqual({calls:5,actions:1,closes:1});
});

test('a vanished live-game control lets the Reviewer observe again and continue',async()=>{
  let attempts=0;
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:{observationId?:string;id?:string}|null=null;
    try{data=last?JSON.parse(last.content):null;}catch{ /* stale-ref tool error */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};
    if(n===3)return {name:'browser_observe',args:{}};
    if(n===4)return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};
    return {name:'record_behavior',args:report([String(data?.id)]).items[0]};
  });
  const act=f.input.browser.act;
  f.input.browser.act=async action=>{
    if(++attempts===1)throw new RuntimeError('STALE_BROWSER_REF','页面控件已变化，请重新观察');
    return act(action);
  };
  const result=await runReviewer(f.input);
  expect(result.result.items[0].verdict).toBe('passed');
  expect(attempts).toBe(2);
  expect(f.stats()).toEqual({calls:5,actions:1,closes:1});
});

test('an unrelated browser CLI failure still ends the Reviewer as CHECK_BLOCKED',async()=>{
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{}};
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};
  });
  f.input.browser.act=async()=>{throw new RuntimeError('BROWSER_BLOCKED','浏览器动作失败');};
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'CHECK_BLOCKED'});
  expect(f.stats().closes).toBe(1);
});

test('Reviewer resizes to 390 CSS pixels and receives layout evidence before a real behavior action',async()=>{
  let measured='',resizeEvidenceId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data=null;try{data=last?JSON.parse(last.content):null;}catch{ /* Unknown tools return an error before this capability exists. */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_resize',args:{width:390,height:844}};
    if(n===3&&data?.observationId){
      measured=data.text;resizeEvidenceId=data.id;
      return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    }
    return {name:'record_behavior',args:report([data?.id??randomUUID()]).items[0]};
  });
  const result=await runReviewer({...f.input,maxToolCalls:4});
  expect(measured).toContain('width=390 height=844 scrollWidth=390');
  expect(result.evidence.find(event=>event.id===resizeEvidenceId)).toMatchObject({action:null,behaviorId:null});
  expect(result.result.items[0]).toMatchObject({behaviorId:'B01',verdict:'passed'});
  expect(f.stats()).toEqual({calls:4,actions:1,closes:1});
});

test('a static render-only behavior passes with one observation and a screenshot',async()=>{
  const ids:string[]=[];
  let artifactId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){ids.push(data.id);return {name:'browser_screenshot',args:{}};}
    // Screenshot results expose `artifactId`; observation event ids are `id`.
    artifactId=data.artifactId;
    return {name:'record_behavior',args:{...report(ids).items[0],screenshotIds:[artifactId],reproSteps:['打开页面并观察渲染内容']}};
  });
  f.input.handoff.plan = { ...f.input.handoff.plan,
    behaviors: [{ ...f.input.handoff.plan.behaviors[0], action: '直接查看页面初始状态。' }] };
  const result=await runReviewer(f.input);
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats()).toEqual({calls:3,actions:0,closes:1});
  assertReviewerResult(result);
});

test('a bound browser observationId is canonicalized to its event ID before storing a static check',async()=>{
  let eventId='',browserObservationId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content) as {id?:string;observationId?:string;artifactId?:string}:null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){eventId=String(data?.id);browserObservationId=String(data?.observationId);
      return {name:'browser_screenshot',args:{}};}
    return {name:'record_behavior',args:{...report([browserObservationId]).items[0],
      screenshotIds:[data?.artifactId],reproSteps:['查看初始静态画面']}};
  });
  f.input.handoff.plan={...f.input.handoff.plan,
    behaviors:[{...f.input.handoff.plan.behaviors[0],action:'直接查看页面初始状态。'}]};
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(eventId).not.toBe(browserObservationId);
  expect(result.result.items[0].observationEventIds).toEqual([eventId]);
  expect(result.result.items[0].verdict).toBe('passed');
});

test('an interactive check may reference its own browser observationId without accepting foreign evidence',async()=>{
  let eventId='',browserObservationId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content) as {id?:string;observationId?:string;artifactId?:string}:null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};
    if(n===3){eventId=String(data?.id);browserObservationId=String(data?.observationId);
      return {name:'browser_screenshot',args:{}};}
    return {name:'record_behavior',args:{...report([browserObservationId]).items[0],screenshotIds:[data?.artifactId]}};
  });
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(result.result.items[0].observationEventIds).toEqual([eventId]);
  expect(f.stats().actions).toBe(1);
});

test.each(['blank','menu'])('negative fixture: %s Canvas cannot pass an interactive behavior without a key',{timeout:30_000},async mode=>{
  let firstObservationEventId='',screenshotId='',imageReachedProvider=false;
  const screenshot=readFileSync(new URL(`../fixtures/canvas-negative/images/${mode}-page-initial.png`,import.meta.url));
  const screenshotSha256=createHash('sha256').update(screenshot).digest('hex');
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:Record<string,unknown>|null=null;
    try{data=last?JSON.parse(last.content) as Record<string,unknown>:null;}
    catch{ /* The first rejected report is returned as a tool error. */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){firstObservationEventId=String(data?.id);return {name:'browser_screenshot',args:{}};}
    screenshotId=String(data?.artifactId??screenshotId);
    const imageMessage=request.messages.filter(message=>message.role==='user' && Array.isArray(message.content as unknown)).at(-1);
    imageReachedProvider=Boolean((imageMessage?.content as unknown as Array<{type:string;image_url?:{url:string}}> | undefined)
      ?.some(part=>part.type==='image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')));
    return {name:'record_behavior',args:{...report([firstObservationEventId]).items[0],screenshotIds:[screenshotId],
      actual:'仅显示开始菜单，未发送方向键',reproSteps:['打开页面','截取初始画面']}};
  });
  f.input.handoff.plan={...f.input.handoff.plan,
    behaviors:[{...f.input.handoff.plan.behaviors[0],title:'方向控制',
      action:'发送 ArrowRight 并观察 Canvas 上的蛇改变方向',expected:'蛇根据 ArrowRight 改变方向'}]};
  f.input.browser.open=async()=>({id:randomUUID(),sessionId:f.input.browser.sessionId,
    url:'http://127.0.0.1:4173/',tree:'button 开始 [ref=e1]; canvas',text:`贪吃蛇 · ${mode} · 状态 menu`,
    refs:{e1:{role:'button',name:'开始'}},truncated:false});
  f.input.browser.screenshot=async()=>({base64:screenshot.toString('base64'),sha256:screenshotSha256,mimeType:'image/png'});
  f.input.saveScreenshot=async()=>({id:randomUUID(),mimeType:'image/png',sha256:screenshotSha256});
  let accepted:Awaited<ReturnType<typeof runReviewer>>|undefined;
  try { accepted=await runReviewer({...f.input,requireVisionEvidence:true}); }
  catch(error) { expect(error).toMatchObject({code:'AGENT_OUTPUT_INVALID'}); }
  expect(imageReachedProvider).toBe(true);
  expect(f.stats().actions).toBe(0);
  expect(accepted?.result.items[0].verdict).not.toBe('passed');
});

test('Pi receives actual screenshot bytes with PNG MIME and can reread the same bound image',async()=>{
  let observationEventId='',artifactId='',firstImage='',rereadImage='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){observationEventId=data.id;return {name:'browser_screenshot',args:{}};}
    const imageMessage=request.messages.filter(message=>message.role==='user' && Array.isArray(message.content as unknown)).at(-1);
    const image=(imageMessage?.content as unknown as Array<{type:string;image_url?:{url:string}}> | undefined)?.find(part=>part.type==='image_url')?.image_url?.url??'';
    expect(image).toMatch(/^data:image\/png;base64,/);
    if(n===3){
      artifactId=data.artifactId;firstImage=image;
      expect(data).toMatchObject({revisionId,sourceHash,browserSessionId:f.input.browser.sessionId,mimeType:'image/png'});
      return {name:'screenshot_read',args:{artifactId}};
    }
    rereadImage=image;
    expect(data).toMatchObject({artifactId,revisionId,sourceHash,browserSessionId:f.input.browser.sessionId,mimeType:'image/png'});
    return {name:'record_behavior',args:{...report([observationEventId]).items[0],screenshotIds:[artifactId],reproSteps:['观察当前画面颜色']}};
  });
  f.input.handoff.plan = { ...f.input.handoff.plan,
    behaviors: [{ ...f.input.handoff.plan.behaviors[0], action: '直接查看页面当前画面。' }] };
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(firstImage).toBe(rereadImage);
  expect(result.artifacts.map(artifact=>artifact.id)).toContain(artifactId);
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats()).toEqual({calls:4,actions:0,closes:1});
});

test('an unverified image model blocks Reviewer before Provider I/O and closes the browser',async()=>{
  const f=setup(()=>({name:'browser_open',args:{}}));
  f.input.modelConfig.supportsImages=false;
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'VISION_NOT_VERIFIED'});
  expect(f.stats()).toEqual({calls:0,actions:0,closes:1});
});

test('a passing DOM report is rejected when no image entered a later Provider request',async()=>{
  let actionId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:null|{observationId?:string;id?:string}=null;
    try{data=last?JSON.parse(last.content):null;}catch{ /* The first rejected report is a static tool error. */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};
    actionId ||= data?.id??'';
    return {name:'submit_review',args:report([actionId])};
  });
  await expect(runReviewer({...f.input,requireVisionEvidence:true})).rejects.toMatchObject({
    code:'AGENT_OUTPUT_INVALID',message:expect.stringContaining('IMAGE_EVIDENCE_REQUIRED'),
  });
  expect(f.stats()).toEqual({calls:5,actions:1,closes:1});
});

test('Canvas key batch binds every input result, fresh observation and delivered image to the current revision',async()=>{
  let batchEventId='';
  let batchToolResult:Record<string,unknown>|undefined;
  let batchCalls=0;
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content) as Record<string,unknown>:null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_key_batch',args:{behaviorId:'B01',observationId:data?.observationId,
      steps:[{key:'ArrowUp',waitMs:100},{key:'ArrowRight',waitMs:100},{key:'Space',waitMs:0}]}};
    if(n===3){batchEventId=String(data?.id);batchToolResult=data??undefined;return {name:'browser_screenshot',args:{}};}
    return {name:'record_behavior',args:{...report([batchEventId]).items[0],
      screenshotIds:[data?.artifactId],actual:'Canvas 与 HUD 在键盘操作后更新',reproSteps:['上、右、空格']}};
  });
  f.input.browser.keyBatch=async({steps})=>{
    batchCalls++;
    return {observation:{...await f.input.browser.observe(),text:'Canvas HUD score=1'},
      startedAt:'2026-09-23T18:00:00.000Z',finishedAt:'2026-09-23T18:00:00.250Z',
      steps:steps.map((step,index)=>({index,...step,success:true}))};
  };
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(batchCalls).toBe(1);
  expect(batchToolResult).toMatchObject({revisionId,sourceHash,browserSessionId:f.input.browser.sessionId,
    batch:{steps:[{index:0,key:'ArrowUp',success:true},{index:1,key:'ArrowRight',success:true},{index:2,key:'Space',success:true}]}});
  const evidence=result.evidence.find(event=>event.id===batchEventId);
  expect(evidence).toMatchObject({behaviorId:'B01',action:'key_batch',batch:{startedAt:'2026-09-23T18:00:00.000Z'}});
  expect(evidence?.batch?.steps).toMatchObject([
    {index:0,key:'ArrowUp',waitMs:100,success:true},
    {index:1,key:'ArrowRight',waitMs:100,success:true},
    {index:2,key:'Space',waitMs:0,success:true},
  ]);
  expect(result.result.items[0].verdict).toBe('passed');
});

test('a failed Canvas input cannot pass and is reported blocked after the one correction turn',async()=>{
  let batchEventId='';
  let rejected='';
  const batchCompleted:boolean[]=[];
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:Record<string,unknown>|null=null;
    try{data=last?JSON.parse(last.content) as Record<string,unknown>:null;}
    catch{rejected=String(last?.content??'');}
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_key_batch',args:{behaviorId:'B01',observationId:data?.observationId,
      steps:[{key:'ArrowUp',waitMs:100},{key:'ArrowRight',waitMs:100}]}};
    if(n===3){batchEventId=String(data?.id);return {name:'record_behavior',args:report([batchEventId]).items[0]};}
    return {name:'record_behavior',args:{...report([batchEventId]).items[0],verdict:'blocked',
      actual:'第二个方向键未执行，无法判断游戏响应',reproSteps:['重试方向键失败']}};
  });
  f.input.browser.keyBatch=async({steps})=>({observation:await f.input.browser.observe(),
    startedAt:'2026-09-23T18:00:00.000Z',finishedAt:'2026-09-23T18:00:00.200Z',
    steps:steps.map((step,index)=>({index,...step,success:index===0}))});
  const result=await runReviewer({...f.input,onEvent:async(event:ProbeEvent)=>{
    if(event.type==='tool.end'&&event.toolName==='browser_key_batch')batchCompleted.push(event.success===true);
  }});
  expect(rejected).toContain('INPUT_FAILED');
  expect(batchCompleted).toEqual([false]);
  expect(result.result.items[0].verdict).toBe('blocked');
  expect(result.evidence.find(event=>event.id===batchEventId)?.batch?.steps.map(step=>step.success)).toEqual([true,false]);
});

test('a screenshot from before an action cannot prove that action even if its image reached the Provider',async()=>{
  let oldArtifactId='',actionEventId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:Record<string,unknown>|null=null;
    try{data=last?JSON.parse(last.content) as Record<string,unknown>:null;}catch{ /* Rejected report tool output. */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_screenshot',args:{}};
    if(n===3){oldArtifactId=String(data?.artifactId);return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};}
    if(n===4)actionEventId=String(data?.id);
    return {name:'submit_review',args:{...report([actionEventId]),items:[{...report([actionEventId]).items[0],screenshotIds:[oldArtifactId]}]}};
  });
  await expect(runReviewer({...f.input,requireVisionEvidence:true})).rejects.toMatchObject({
    code:'AGENT_OUTPUT_INVALID',message:expect.stringContaining('IMAGE_EVIDENCE_REQUIRED'),
  });
  expect(f.stats().actions).toBe(1);
});

test('one successful key cannot clear a failed multi-key Canvas sequence',async()=>{
  let lastEventId='',attempt=0;
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:Record<string,unknown>|null=null;
    try{data=last?JSON.parse(last.content) as Record<string,unknown>:null;}catch{ /* Rejected report tool output. */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_key_batch',args:{behaviorId:'B01',observationId:data?.observationId,
      steps:[{key:'ArrowUp',waitMs:100},{key:'ArrowRight',waitMs:100}]}};
    if(n===3)return {name:'browser_key_batch',args:{behaviorId:'B01',observationId:data?.observationId,
      steps:[{key:'ArrowUp',waitMs:100}]}};
    if(n===4)lastEventId=String(data?.id);
    return {name:'record_behavior',args:report([lastEventId]).items[0]};
  });
  f.input.browser.keyBatch=async({steps})=>{
    attempt++;
    return {observation:await f.input.browser.observe(),startedAt:'2026-09-23T18:00:00.000Z',
      finishedAt:'2026-09-23T18:00:00.200Z',steps:steps.map((step,index)=>({index,...step,success:attempt!==1||index===0}))};
  };
  await expect(runReviewer(f.input)).rejects.toMatchObject({
    code:'AGENT_OUTPUT_INVALID',message:expect.stringContaining('INPUT_FAILED'),
  });
  expect(attempt).toBe(2);
});

test('a transient provider failure is retried with bounded backoff and still reaches a real check',{timeout:90_000},async()=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)throw new Error('503 service unavailable');
    if(n===2)return {name:'browser_open',args:{path:'/'}};
    if(n===3)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    return {name:'submit_review',args:report([data.id])};
  });
  const started=Date.now();
  const result=await runReviewer(f.input);
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats()).toEqual({calls:4,actions:1,closes:1});
  // The retry must have waited the policy's first backoff step, not spun.
  expect(Date.now()-started).toBeGreaterThanOrEqual(900);
});

test('a failed retry event append prevents Reviewer from accepting a passing report',{timeout:90_000},async()=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)throw new Error('503 service unavailable');
    if(n===2)return {name:'browser_open',args:{path:'/'}};
    if(n===3)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    return {name:'submit_review',args:report([data.id])};
  });
  await expect(runReviewer({...f.input,onEvent:async(event)=>{
    if(event.type==='model.stream.started')throw new Error('Fixture event store unavailable');
  }})).rejects.toMatchObject({code:'EVENT_APPEND_FAILED'});
  expect(f.stats().closes).toBe(1);
});

test('an authentication failure fails fast instead of consuming the retry budget',async()=>{
  const f=setup(()=>({name:'browser_open',args:{}}));
  let attempts=0;
  f.input.modelConfig.fetch=async()=>{attempts++;
    return new Response(JSON.stringify({error:{message:'invalid api key',type:'invalid_request_error'}}),
      {status:401,headers:{'content-type':'application/json'}});};
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'MODEL_FAILED'});
  expect(attempts).toBe(1);
});

test('a persistence reload preserves the observed path, query and hash route with behavior-bound evidence',async()=>{
  const openedPaths:Array<string|undefined>=[];
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{path:'/reading?tab=all'}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    if(n===3)return {name:'browser_reload',args:{behaviorId:'B01',observationId:data.observationId}};
    return {name:'submit_review',args:report([data.id])};
  });
  const open=f.input.browser.open,act=f.input.browser.act;
  f.input.browser.open=async(path)=>{
    openedPaths.push(path);
    return {...await open(path),url:'http://127.0.0.1:4173/books?sort=title#list'};
  };
  f.input.browser.act=async(action)=>({...await act(action),url:'http://127.0.0.1:4173/books?sort=title#list'});
  const result=await runReviewer(f.input);
  expect(openedPaths).toEqual(['/reading?tab=all','/books?sort=title#list']);
  expect(result.evidence[0]).toMatchObject({behaviorId:null,action:null,text:'空书单'});
  expect(result.evidence.at(-1)).toMatchObject({behaviorId:'B01',action:'reload',text:'测试书名'});
  expect(result.result.items[0].observationEventIds).toEqual([result.evidence.at(-1)?.id]);
  expect(result.usage.toolCalls).toBe(4);
  expect(f.stats()).toEqual({calls:4,actions:1,closes:1});
});

test('a transient blocked reload retries the same path once and records only the new observation',async()=>{
  const openedPaths:Array<string|undefined>=[];
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{path:'/reading?tab=all'}};
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)!.content);
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    if(n===3)return {name:'browser_reload',args:{behaviorId:'B01',observationId:data.observationId}};
    return {name:'submit_review',args:report([data.id])};
  });
  const open=f.input.browser.open;
  f.input.browser.open=async(path)=>{
    openedPaths.push(path);
    if(openedPaths.length===2)throw new RuntimeError('BROWSER_BLOCKED','private CLI failure');
    return open(path);
  };
  const result=await runReviewer(f.input);
  expect(openedPaths).toEqual(['/reading?tab=all','/','/']);
  expect(result.evidence.filter(entry=>entry.action==='reload')).toHaveLength(1);
  expect(result.evidence.at(-1)).toMatchObject({behaviorId:'B01',action:'reload',text:'测试书名'});
  expect(result.result.items[0].observationEventIds).toEqual([result.evidence.at(-1)?.id]);
  expect(result.usage.toolCalls).toBe(4);
  expect(f.stats()).toEqual({calls:4,actions:1,closes:1});
});

test('two blocked reload navigations still fail the check without a report turn',async()=>{
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{path:'/'}};
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)!.content);
    return {name:'browser_reload',args:{behaviorId:'B01',observationId:data.observationId}};
  });
  const open=f.input.browser.open;let opens=0;
  f.input.browser.open=async(path)=>{
    if(++opens>1)throw new RuntimeError('BROWSER_BLOCKED','private CLI failure');
    return open(path);
  };
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'CHECK_BLOCKED'});
  expect(opens).toBe(3);
  expect(f.stats()).toEqual({calls:2,actions:0,closes:1});
});

test('cancellation after the first blocked reload prevents the second navigation',async()=>{
  const controller=new AbortController();
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{path:'/'}};
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)!.content);
    return {name:'browser_reload',args:{behaviorId:'B01',observationId:data.observationId}};
  });
  const open=f.input.browser.open;let opens=0;
  f.input.browser.open=async(path)=>{
    if(++opens>1){controller.abort('CANCELLED');throw new RuntimeError('BROWSER_BLOCKED','private CLI failure');}
    return open(path);
  };
  await expect(runReviewer({...f.input,signal:controller.signal})).rejects.toMatchObject({code:'CANCELLED'});
  expect(opens).toBe(2);
});

test('a retry that returns the old observation cannot count as reload evidence',async()=>{
  let original:Awaited<ReturnType<ReviewBrowser['open']>>|undefined;let opens=0;
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{path:'/'}};
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)!.content);
    return {name:'browser_reload',args:{behaviorId:'B01',observationId:data.observationId}};
  });
  const open=f.input.browser.open;
  f.input.browser.open=async(path)=>{
    if(++opens===1)return original=await open(path);
    if(opens===2)throw new RuntimeError('BROWSER_BLOCKED','private CLI failure');
    return original!;
  };
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'CHECK_BLOCKED'});
  expect(opens).toBe(3);
});

test.each(['not-opened','observe-before-open','stale','wrong-behavior'])('reload refuses %s without reopening the page',async(mode)=>{
  let firstObservationId='',opens=0;
  const maxTools=mode==='not-opened'?1:mode==='stale'?3:2;
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(mode==='not-opened')return {name:'browser_reload',args:{behaviorId:'B01',observationId:randomUUID()}};
    if(n===1)return {name:mode==='observe-before-open'?'browser_observe':'browser_open',args:{}};
    if(mode==='stale'&&n===2){firstObservationId=data.observationId;return {name:'browser_observe',args:{}};}
    return {name:'browser_reload',args:{behaviorId:mode==='wrong-behavior'?'B99':'B01',observationId:firstObservationId||data.observationId}};
  });
  const open=f.input.browser.open;
  f.input.browser.open=async(path)=>{opens++;return open(path);};
  await expect(runReviewer({...f.input,maxToolCalls:maxTools})).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(opens).toBe(mode==='not-opened'||mode==='observe-before-open'?0:1);
  expect(f.stats()).toEqual({calls:maxTools,actions:0,closes:1});
});

test('reload cannot start after expiry while its tool.start is being saved',async()=>{
  let opens=0;const controller=new AbortController();
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{}};
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)!.content);
    return {name:'browser_reload',args:{behaviorId:'B01',observationId:data.observationId}};
  });
  const open=f.input.browser.open;
  f.input.browser.open=async(path)=>{opens++;return open(path);};
  await expect(runReviewer({...f.input,signal:controller.signal,onEvent:async(event)=>{
    if(event.type==='tool.start'&&event.toolName==='browser_reload')controller.abort('REVIEW_TIMEOUT');
  }})).rejects.toMatchObject({code:'REVIEW_TIMEOUT'});
  expect(opens).toBe(1);expect(f.stats()).toEqual({calls:2,actions:0,closes:1});
});

test('reload refuses a response outside the bound preview and closes without another model turn',async()=>{
  let opens=0;
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{}};
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)!.content);
    return {name:'browser_reload',args:{behaviorId:'B01',observationId:data.observationId}};
  });
  const open=f.input.browser.open;
  f.input.browser.open=async(path)=>({...await open(path),url:++opens===1?'http://127.0.0.1:4173/':'https://outside.invalid/'});
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'CHECK_BLOCKED'});
  expect(opens).toBe(2);expect(f.stats()).toEqual({calls:2,actions:0,closes:1});
});

test('a page title alone cannot satisfy a required behavior',async()=>{
  const f=setup((request,n)=>{
    if(n===1)return {name:'browser_open',args:{path:'/'}};
    const observations=request.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).filter(v=>v?.id);
    return {name:'submit_review',args:report([observations[0].id])};
  });
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats()).toEqual({calls:4,actions:0,closes:1});
});

test('Reviewer cannot call a write or shell tool and hidden reasoning stays outside public evidence',async()=>{
  const f=setup((_request,n)=>n===1?{name:'bash',args:{command:'touch /tmp/reviewer-escape'}}:{name:'submit_review',args:report([])});
  const events: unknown[]=[];
  await expect(runReviewer({...f.input,onEvent:(event)=>{events.push(event);}})).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats().actions).toBe(0);expect(f.stats().closes).toBe(1);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_HIDDEN_REASONING');
  expect(JSON.stringify(events)).not.toContain('private-review-key');
});

test('a runtime page exception cannot become a passed check',async()=>{
  let eventId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);let data=null;try{data=last?JSON.parse(last.content):null;}catch{ /* Prior rejected report is a tool error string. */ }
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    if(data?.id)eventId=data.id;
    return {name:'submit_review',args:report([eventId])};
  });
  f.input.browser.logs=async()=>({errors:[{message:'Uncaught TypeError'}]});
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats().closes).toBe(1);
});

test('a valid report is not accepted when Chrome cannot confirm closure',async()=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    return {name:'submit_review',args:report([data.id])};
  });
  f.input.browser.close=async()=>({confirmed:false});
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'CHECK_BLOCKED'});
});

test('copied report JSON is not a verified runtime result',()=>{
  expect(()=>assertReviewerResult({result:report([]),evidence:[],artifacts:[],chromeClosed:true} as unknown as Parameters<typeof assertReviewerResult>[0]))
    .toThrow('检查结果未经运行时证据校验');
});

test('an observed unsupported email promise remains failed rather than being promoted to passing',async()=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    const failed=report([data.id]);failed.items[0].verdict='failed';failed.items[0].actual='页面声称确认邮件将发送，但源码没有邮件服务。';failed.summary='存在不支持的邮件承诺';
    return {name:'submit_review',args:failed};
  });
  const originalAction=f.input.browser.act;
  f.input.browser.act=async(action)=>({...await originalAction(action),text:'报名成功，确认邮件将发送至测试邮箱。'});
  const result=await runReviewer(f.input);
  assertReviewerResult(result);
  expect(result.result.items[0]).toMatchObject({verdict:'failed',actual:'页面声称确认邮件将发送，但源码没有邮件服务。'});
  expect(result.artifacts).toHaveLength(1);
  expect(f.stats().closes).toBe(1);
});

test.each([
  {code:'BROWSER_BLOCKED',diagnostic:'BROWSER_BLOCKED'},
  {code:'BROWSER_TIMEOUT',diagnostic:'BROWSER_TIMEOUT'},
  {code:'COMMAND_TIMEOUT',diagnostic:'BROWSER_TIMEOUT'},
  {code:'BROWSER_ORIGIN_REJECTED',diagnostic:'BROWSER_ORIGIN_REJECTED'},
  {code:'FORM_TARGET_CHANGED',diagnostic:'FORM_TARGET_CHANGED'},
  {code:'INVALID_BROWSER_ACTION',diagnostic:'INVALID_BROWSER_ACTION'},
  {code:'INVALID_BROWSER_ARGUMENTS',diagnostic:'BROWSER_BLOCKED'},
  {code:'PRIVATE_UNKNOWN_CODE',diagnostic:'BROWSER_BLOCKED'},
  {code:undefined,diagnostic:'BROWSER_BLOCKED'},
])('$code ends the attempt with a static cause without replaying a side effect',async({code,diagnostic})=>{
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);const data=last?JSON.parse(last.content):null;
    return n===1?{name:'browser_open',args:{}}:{name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
  });
  const {RuntimeError}=await import('../../src/runtime/types.js');let tries=0;
  f.input.browser.act=async()=>{tries++;throw code?new RuntimeError(code,'PRIVATE_PROVIDER_MESSAGE private-review-key'):undefined;};
  const pending=runReviewer(f.input);
  await expect(pending).rejects.toMatchObject({code:'CHECK_BLOCKED',diagnosticCode:diagnostic});
  await expect(pending).rejects.not.toThrow('PRIVATE_');
  await expect(pending).rejects.not.toThrow('private-review-key');
  expect(tries).toBe(1);expect(f.stats().closes).toBe(1);expect(f.stats().calls).toBe(2);
});

test('a provider failure is never converted into a report-correction turn',{timeout:90_000},async()=>{
  const f=setup(()=>{throw new Error('External provider unavailable');});
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'MODEL_FAILED'});
  // Only the bounded transport retry budget runs; no second prompt asks the
  // model to "correct" a provider outage into a report.
  expect(f.stats().calls).toBe(PROVIDER_RETRY_POLICY.maxRetries+1);expect(f.stats().closes).toBe(1);
});

test('Reviewer shares the run token budget and refuses before external provider I/O',async()=>{
  const {createRunTokenBudget}=await import('../../src/runtime/token-budget.js');
  const f=setup(()=>({name:'browser_open',args:{}}));
  await expect(runReviewer({...f.input,tokenBudget:createRunTokenBudget(1)})).rejects.toMatchObject({code:'TOKEN_BUDGET_EXCEEDED'});
  expect(f.stats()).toEqual({calls:0,actions:0,closes:1});
});

test('parent cancellation stops a stalled Reviewer model stream and closes its browser',async()=>{
  const f=setup(()=>({name:'browser_open',args:{}})), controller=new AbortController();
  f.input.modelConfig.fetch=async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
    const signal=init?.signal;
    if(signal?.aborted)reject(new Error('aborted'));
    else signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  });
  const pending=runReviewer({...f.input,signal:controller.signal});
  const result=pending.then(()=> 'unexpected success',error=>error.code);
  const cancel=setTimeout(()=>controller.abort('CANCELLED'),30);
  try{
    expect(await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('NO_CANCEL'),150))])).toBe('CANCELLED');
  }finally{clearTimeout(cancel);controller.abort('CANCELLED');await result;}
  expect(f.stats().closes).toBe(1);
});

test('an explicit parent timeout while persisting tool.start prevents a browser operation',async()=>{
  const f=setup(()=>({name:'browser_open',args:{}})), controller=new AbortController();
  let opens=0;
  const open=f.input.browser.open;
  f.input.browser.open=async(path)=>{opens++;return open(path);};
  await expect(runReviewer({...f.input,signal:controller.signal,onEvent:async(event)=>{
    if(event.type==='tool.start')controller.abort('REVIEW_TIMEOUT');
  }})).rejects.toMatchObject({code:'REVIEW_TIMEOUT'});
  expect(opens).toBe(0);
  expect(f.stats().closes).toBe(1);
});

test('earlier browser observations remain in Pi context until native compaction and saved evidence stays complete',async()=>{
  let history: Array<Record<string,unknown>>=[];
  let memory: {observations:Array<Record<string,unknown>>}|undefined;
  const f=setup((request,n)=>{
    const observations=request.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).filter(m=>m.observationId);
    const latest=observations.at(-1);
    if(n===1)return {name:'browser_open',args:{}};
    if(n<4)return {name:'browser_click',args:{behaviorId:'B01',observationId:latest.observationId,ref:'e1'}};
    history=observations;
    memory=request.messages.filter(m=>m.role==='user').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(m=>m?.type==='review_memory');
    return {name:'submit_review',args:report([latest.id])};
  });
  const open=f.input.browser.open, act=f.input.browser.act;
  f.input.browser.open=async()=>({...await open(),text:'initial '.repeat(1000)});
  f.input.browser.act=async(action)=>({...await act(action),text:'result '.repeat(1000)});
  const result=await runReviewer(f.input);
  expect(history).toHaveLength(3);
  expect(history[0]).toMatchObject({id:result.evidence[0].id,tree:'button 添加 [ref=e1]'});
  expect(String(history[0].text).length).toBeGreaterThan(1000);
  expect(memory).toBeUndefined();
  expect(history.at(-1)).toMatchObject({tree:'button 添加 [ref=e1]',refs:{e1:{role:'button',name:'添加'}}});
  expect(result.evidence[0].text).toBe('initial '.repeat(1000));
  expect(result.evidence.at(-1)?.text).toBe('result '.repeat(1000));
});

test('native Pi compaction keeps a long review running and old observations remain readable by ID',{timeout:90_000},async()=>{
  let firstObservationId='', lastActionId='', reread=false, summaries=0;
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)firstObservationId=data.id;
    if(n<=7){lastActionId=data.id;return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};}
    if(n===8){lastActionId=data.id;return {name:'observation_read',args:{id:firstObservationId}};}
    reread=data?.id===firstObservationId && String(data?.text).length>=10_000;
    return {name:'submit_review',args:report([lastActionId])};
  },n=>n===5?{prompt_tokens:13_000,completion_tokens:5,total_tokens:13_005}:{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  const originalFetch=f.input.modelConfig.fetch!;
  f.input.modelConfig.contextWindow=16_000;
  f.input.modelConfig.fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(Array.isArray(request.tools)&&request.tools.length)return originalFetch(url,init);
    summaries++;
    const chunk={id:'compaction-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'Earlier browser evidence is retained by observation ID. Continue checking B01.'},finish_reason:null}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const observe=f.input.browser.open,act=f.input.browser.act;
  f.input.browser.open=async(path)=>({...await observe(path),text:'早期观察'.repeat(2500)});
  f.input.browser.act=async(action)=>({...await act(action),text:'后续观察'.repeat(2500)});
  const result=await runReviewer(f.input);
  expect(summaries).toBeGreaterThan(0);
  expect(reread).toBe(true);
  expect(result.result.items[0].verdict).toBe('passed');
  expect(result.evidence[0].id).toBe(firstObservationId);
});

test('after Pi compaction the Reviewer can reread the actual current-revision PNG, not merely its artifact ID',{timeout:90_000},async()=>{
  let observationEventId='',artifactId='',summaries=0,rereadImage=false;
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){observationEventId=data.id;return {name:'browser_screenshot',args:{}};}
    if(n===3)artifactId=data.artifactId;
    if(n<=5)return {name:'browser_observe',args:{}};
    if(n===6)return {name:'screenshot_read',args:{artifactId}};
    const imageMessage=request.messages.filter(message=>message.role==='user' && Array.isArray(message.content as unknown)).at(-1);
    rereadImage=Boolean((imageMessage?.content as unknown as Array<{type:string;image_url?:{url:string}}> | undefined)
      ?.some(part=>part.type==='image_url' && part.image_url?.url.startsWith('data:image/png;base64,')));
    expect(data).toMatchObject({artifactId,revisionId,sourceHash,mimeType:'image/png'});
    return {name:'record_behavior',args:{...report([observationEventId]).items[0],screenshotIds:[artifactId],reproSteps:['压缩后重新读取画面']}};
  },n=>n===5?{prompt_tokens:13_000,completion_tokens:5,total_tokens:13_005}:{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  f.input.handoff.plan = { ...f.input.handoff.plan,
    behaviors: [{ ...f.input.handoff.plan.behaviors[0], action: '直接查看页面当前画面。' }] };
  f.input.modelConfig.contextWindow=16_000;
  const open=f.input.browser.open,observe=f.input.browser.observe;
  f.input.browser.open=async(path)=>({...await open(path),text:'initial image observation '.repeat(400)});
  f.input.browser.observe=async()=>({...await observe(),text:'later image observation '.repeat(400)});
  const originalFetch=f.input.modelConfig.fetch!;
  f.input.modelConfig.fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(Array.isArray(request.tools)&&request.tools.length)return originalFetch(url,init);
    summaries++;
    const chunk={id:'image-compaction-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'The screenshot artifact can be reread after compaction.'},finish_reason:null}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const result=await runReviewer({...f.input,requireVisionEvidence:true});
  expect(summaries).toBeGreaterThan(0);
  expect(rereadImage).toBe(true);
  expect(result.result.items[0].verdict).toBe('passed');
});

test('cancelling native Pi compaction stops Reviewer and closes its browser',{timeout:30_000},async()=>{
  const controller=new AbortController();
  let compactionStarted=false,compactionAborted=false;
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n<=5)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    throw Error('A cancelled compaction must not start another Reviewer turn');
  },n=>n===5?{prompt_tokens:13_000,completion_tokens:5,total_tokens:13_005}:{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  f.input.modelConfig.contextWindow=16_000;
  const observe=f.input.browser.open,act=f.input.browser.act;
  f.input.browser.open=async(path)=>({...await observe(path),text:'早期观察'.repeat(2500)});
  f.input.browser.act=async(action)=>({...await act(action),text:'后续观察'.repeat(2500)});
  const originalFetch=f.input.modelConfig.fetch;
  f.input.modelConfig.fetch=async(url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(Array.isArray(request.tools)&&request.tools.length)return originalFetch(url,init);
    compactionStarted=true;
    return new Promise<Response>((_resolve,reject)=>{
      const stop=()=>{compactionAborted=true;reject(new DOMException('Compaction request stopped','AbortError'));};
      if(init?.signal?.aborted)stop();
      else init?.signal?.addEventListener('abort',stop,{once:true});
      queueMicrotask(()=>controller.abort('CANCELLED'));
    });
  };
  await expect(runReviewer({...f.input,signal:controller.signal})).rejects.toMatchObject({code:'CANCELLED'});
  expect(compactionStarted).toBe(true);
  expect(compactionAborted).toBe(true);
  expect(f.stats().closes).toBe(1);
});

test('Reviewer can retrieve an older complete observation without redoing its action',async()=>{
  let firstId='',lastActionId='';let retrieved='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){firstId=data.id;return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};}
    if(n===3){lastActionId=data.id;return {name:'observation_read',args:{id:firstId}};}
    retrieved=data.text;
    return {name:'submit_review',args:report([lastActionId])};
  });
  const open=f.input.browser.open;
  f.input.browser.open=async()=>({...await open(),text:'complete old observation '.repeat(200)});
  const result=await runReviewer(f.input);
  expect(retrieved).toBe('complete old observation '.repeat(200));
  expect(result.evidence).toHaveLength(2);
  expect(f.stats()).toEqual({calls:4,actions:1,closes:1});
});

test('validated behavior progress remains available and completes without replaying actions',async()=>{
  let remembered:unknown;
  const second={...plan.behaviors[0],id:'B02',title:'再次检查',expected:'仍有书名'};
  const f=setup((request,n)=>{
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)?.content??'null');
    const recorded=request.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(m=>m?.recorded===true);
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    if(n===3)return {name:'record_behavior',args:report([data.id]).items[0]};
    if(n===4)return {name:'browser_observe',args:{}};
    if(n===5){remembered=recorded;return {name:'browser_click',args:{behaviorId:'B02',observationId:data.observationId,ref:'e1'}};}
    if(n===6)return {name:'record_behavior',args:{...report([data.id]).items[0],behaviorId:'B02',expected:second.expected}};
    throw Error('Unexpected model turn after all behaviors recorded');
  });
  f.input.handoff.plan={...plan,behaviors:[...plan.behaviors,second]};
  const result=await runReviewer(f.input);
  expect(remembered).toMatchObject({recorded:true,remainingBehaviorIds:['B02']});
  expect(result.result.items.map(i=>i.behaviorId)).toEqual(['B01','B02']);
  expect(f.stats()).toEqual({calls:6,actions:2,closes:1});
  assertReviewerResult(result);
});

test('a 21-target grouped check records an action and delivered post-action image for every item', { timeout: 120_000 }, async()=>{
  const targets=Array.from({length:21},(_,index)=>({
    id:`B${String(index+1).padStart(2,'0')}`,title:`目标 ${index+1}`,precondition:'页面已打开',
    action:'点击添加',expected:`目标 ${index+1} 已响应`,required:true,
  }));
  const groupedPlan={schemaVersion:2 as const,goal:'检查完整应用',changeSummary:'检查五组目标',assumptions:[],outOfScope:[],
    behaviors:targets,groups:Array.from({length:5},(_,index)=>({
      id:`G${index+1}` as 'G1'|'G2'|'G3'|'G4'|'G5',title:`第 ${index+1} 组`,
      behaviorIds:targets.slice(index===0?0:5+(index-1)*4,index===0?5:5+index*4).map(target=>target.id),
    })),replacements:[]};
  let nextObservationId='',currentActionId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    const index=Math.floor((n-2)/3),phase=(n-2)%3,target=targets[index];
    if(phase===0)return {name:'browser_click',args:{behaviorId:target.id,
      observationId:nextObservationId||data.observationId,ref:'e1'}};
    if(phase===1){currentActionId=data.id;nextObservationId=data.observationId;return {name:'browser_screenshot',args:{}};}
    const imageMessages=request.messages.filter(message=>message.role==='user'&&Array.isArray(message.content));
    expect(imageMessages.some(message=>(message.content as unknown as Array<{type:string}>).some(part=>part.type==='image_url'))).toBe(true);
    expect(data.recordBehaviorNext).toBe(target.id);
    return {name:'record_behavior',args:{behaviorId:target.id,verdict:'passed',expected:target.expected,
      actual:`${target.title} 已在点击后响应`,observationEventIds:[currentActionId],
      screenshotIds:[data.artifactId],reproSteps:['点击添加并核对画面']}};
  });
  const result=await runReviewer({...f.input,handoff:{...f.input.handoff,plan:groupedPlan},requireVisionEvidence:true,maxToolCalls:100});
  expect(result.result.items.map(item=>item.behaviorId)).toEqual(targets.map(target=>target.id));
  expect(result.result.items.every(item=>item.verdict==='passed'&&item.screenshotIds.length===1)).toBe(true);
  expect(result.artifacts).toHaveLength(21);
  expect(f.stats()).toEqual({calls:64,actions:21,closes:1});
});

test('an older identical PNG cannot prove delivery of a later behavior screenshot',async()=>{
  const first=randomUUID(),second=randomUUID(),data='aW1hZ2UtYnl0ZXM=';
  const captures=new Map([first,second].map(id=>[id,{image:{type:'image' as const,data,mimeType:'image/png'}}]));
  const tool=(artifactId:string)=>({role:'tool',content:JSON.stringify({artifactId})});
  const image={role:'user',content:[{type:'text',text:'Captured screenshot'},
    {type:'image_url',image_url:{url:`data:image/png;base64,${data}`}}]};
  const body=JSON.stringify({messages:[tool(first),image,tool(second),
    {role:'user',content:[{type:'text',text:'Image omitted before Provider request'}]}]});
  expect(deliveredScreenshotIdsFromRequest(body,captures)).toEqual(new Set([first]));
  expect(deliveredScreenshotIdsFromRequest(JSON.stringify({messages:[tool(first),image,tool(second),image]}),captures))
    .toEqual(new Set([first,second]));
  const anthropicResult=(artifactId:string,includeImage:boolean)=>({type:'tool_result',tool_use_id:randomUUID(),
    content:[{type:'text',text:JSON.stringify({artifactId})},
      ...(includeImage?[{type:'image',source:{type:'base64',media_type:'image/png',data}}]:[])]});
  expect(deliveredScreenshotIdsFromRequest(JSON.stringify({messages:[{role:'user',content:[
    anthropicResult(first,true),anthropicResult(second,false)]}]}),captures)).toEqual(new Set([first]));
  expect(deliveredScreenshotIdsFromRequest(JSON.stringify({messages:[{role:'user',content:[
    anthropicResult(first,true),anthropicResult(second,true)]}]}),captures)).toEqual(new Set([first,second]));
});

test('Reviewer can collect related behaviors before reporting and bounds repetitive single-step actions',async()=>{
  const second={...plan.behaviors[0],id:'B02',title:'第二项检查',expected:'第二项结果可见'};
  let firstEventId='',firstObservationId='',rejection='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:Record<string,unknown>|null=null;
    try{data=last?JSON.parse(last.content) as Record<string,unknown>:null;}
    catch{rejection=String(last?.content??'');}
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};
    if(n===3){firstEventId=String(data?.id);firstObservationId=String(data?.observationId);
      return {name:'browser_click',args:{behaviorId:'B02',observationId:firstObservationId,ref:'e1'}};}
    return {name:'submit_review',args:{...report([firstEventId]),items:[report([firstEventId]).items[0],
      {...report([String(data?.id)]).items[0],behaviorId:'B02',expected:second.expected}]}};
  });
  const result=await runReviewer({...f.input,handoff:{...f.input.handoff,plan:{...plan,behaviors:[...plan.behaviors,second]}}});
  expect(rejection).toBe('');
  expect(result.result.items.map(item=>item.behaviorId)).toEqual(['B01','B02']);
  expect(f.stats()).toEqual({calls:4,actions:2,closes:1});

  let capRejection='',lastEventId='';
  const spam=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:Record<string,unknown>|null=null;
    try{data=last?JSON.parse(last.content) as Record<string,unknown>:null;}catch{capRejection=String(last?.content??'');}
    if(n===1)return {name:'browser_open',args:{}};
    if(data?.observationId)firstObservationId=String(data.observationId);
    if(data?.id)lastEventId=String(data.id);
    if(n<=34)return {name:'browser_click',args:{behaviorId:'B01',observationId:firstObservationId,ref:'e1'}};
    return {name:'record_behavior',args:report([lastEventId]).items[0]};
  });
  const capped=await runReviewer({...spam.input,maxToolCalls:40});
  expect(capRejection).toContain('32 次浏览器动作');
  expect(capRejection).toContain('record_behavior');
  expect(capped.result.items[0].verdict).toBe('passed');
  expect(spam.stats().actions).toBe(32);
  expect(spam.stats().calls).toBe(35);
});

test('a calculator behavior can clear state and enter a complete parenthesized expression before recording',async()=>{
  let observationId='',eventId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    const data=last?JSON.parse(last.content) as {observationId?:string;id?:string}:null;
    if(n===1)return {name:'browser_open',args:{}};
    if(data?.observationId)observationId=data.observationId;
    if(data?.id)eventId=data.id;
    if(n<=11)return {name:'browser_click',args:{behaviorId:'B01',observationId,ref:'e1'}};
    return {name:'record_behavior',args:report([eventId]).items[0]};
  });
  f.input.handoff.plan = { ...f.input.handoff.plan,
    behaviors: [{ ...f.input.handoff.plan.behaviors[0],
      action: '点击清空，然后依次点击 (、2、+、3、)、*、4、=。', expected: '结果为 20' }] };
  const result=await runReviewer({...f.input,maxToolCalls:20});
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats()).toEqual({calls:12,actions:10,closes:1});
});

test('a later failed input cannot pass after an earlier behavior was recorded',async()=>{
  const second={...plan.behaviors[0],id:'B02',title:'键盘输入',expected:'方向键全部完成'};
  let firstObservationId='',batchEventId='',rejection='',batchCalls=0;
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    let data:Record<string,unknown>|null=null;
    try{data=last?JSON.parse(last.content) as Record<string,unknown>:null;}
    catch{rejection=String(last?.content??'');}
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data?.observationId,ref:'e1'}};
    if(n===3){firstObservationId=String(data?.observationId);
      return {name:'record_behavior',args:report([String(data?.id)]).items[0]};}
    if(n===4)return {name:'browser_key_batch',args:{behaviorId:'B02',observationId:firstObservationId,
      steps:[{key:'ArrowUp',waitMs:100},{key:'ArrowRight',waitMs:100}]}};
    if(n===5){batchEventId=String(data?.id);return {name:'record_behavior',args:{...report([batchEventId]).items[0],
      behaviorId:'B02',expected:second.expected}};}
    return {name:'record_behavior',args:{...report([batchEventId]).items[0],
      behaviorId:'B02',expected:second.expected,verdict:'blocked',actual:'第二个方向键未执行'}};
  });
  f.input.browser.keyBatch=async({steps})=>{
    batchCalls++;
    return {observation:await f.input.browser.observe(),startedAt:'2026-09-23T18:00:00.000Z',
      finishedAt:'2026-09-23T18:00:00.200Z',steps:steps.map((step,index)=>({index,...step,success:index===0}))};
  };
  const result=await runReviewer({...f.input,handoff:{...f.input.handoff,plan:{...plan,behaviors:[...plan.behaviors,second]}}});
  expect(rejection).toContain('INPUT_FAILED');
  expect(result.result.items.map(item=>item.verdict)).toEqual(['passed','blocked']);
  expect(batchCalls).toBe(1);
});

test('exhausting the screenshot quota is recoverable and cannot fail an otherwise valid check',async()=>{
  let actionId='';
  const f=setup((request,n)=>{
    if(n<=81)return {name:'browser_screenshot',args:{}};
    const parse=()=>{const last=request.messages.filter(m=>m.role==='tool').at(-1);const raw=last?last.content:'';try{return JSON.parse(raw);}catch{return null;}};
    if(n===82)return {name:'browser_open',args:{path:'/'}};
    if(n===83)return {name:'browser_click',args:{behaviorId:'B01',observationId:parse().observationId,ref:'e1'}};
    actionId=parse().id;
    return {name:'record_behavior',args:report([actionId]).items[0]};
  });
  const result=await runReviewer({...f.input,maxToolCalls:90});
  expect(result.result.items[0].verdict).toBe('passed');
  // One screenshot over the eighty-artifact ceiling is refused, then the check
  // continues: the quota is a per-attempt ceiling, not a browser failure.
  expect(result.artifacts).toHaveLength(80);
  expect(f.stats().actions).toBe(1);
});

test('progress cannot fabricate evidence or complete a behavior outside the plan',async()=>{
  const f=setup(()=>({name:'record_behavior',args:report([randomUUID()]).items[0]}));
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats()).toEqual({calls:3,actions:0,closes:1});
});

test('the recorded expectation comes from the sealed plan, never from the model restating it',async()=>{
  let actionId='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    actionId=data.id;
    return {name:'record_behavior',args:{...report([actionId]).items[0],expected:'模型自己改写的期望'}};
  });
  const result=await runReviewer(f.input);
  expect(result.result.items[0].expected).toBe(plan.behaviors[0].expected);
  expect(result.result.items[0].expected).not.toBe('模型自己改写的期望');
});

test('an invalid behavior draft exposes a static reason and can be corrected once without echoing its input',async()=>{
  let actionId='',rejection='';
  const privateActual='PRIVATE_SUBMITTED_VALUE';
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    if(n===4){
      rejection=last?.content??'';
      return {name:'record_behavior',args:report([actionId]).items[0]};
    }
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    actionId=data.id;
    // A passing verdict cannot rest on an observation that carries no real
    // action for that behavior; the rejection must name the static reason.
    return {name:'record_behavior',args:{...report([actionId]).items[0],observationEventIds:[randomUUID()],actual:privateActual}};
  });
  const result=await runReviewer(f.input);
  expect(rejection).toContain('OBSERVATION_SCOPE');
  expect(rejection).not.toContain(privateActual);
  expect(rejection).not.toContain('private-review-key');
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats()).toEqual({calls:4,actions:1,closes:1});
});

test('a corrected behavior does not consume the next behavior draft correction opportunity',async()=>{
  let actionId='';
  const rejections:string[]=[];
  const second={...plan.behaviors[0],id:'B02',title:'第二项检查',expected:'第二项动作之后仍有书名'};
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    if(n===4||n===8){
      rejections.push(last?.content??'');
      return {name:'record_behavior',args:{...report([actionId]).items[0],behaviorId:n===4?'B01':'B02'}};
    }
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2||n===6)return {name:'browser_click',args:{behaviorId:n===2?'B01':'B02',observationId:data.observationId,ref:'e1'}};
    if(n===5)return {name:'browser_observe',args:{}};
    actionId=data.id;
    return {name:'record_behavior',args:{...report([randomUUID()]).items[0],behaviorId:n===3?'B01':'B02'}};
  });
  f.input.handoff.plan={...plan,behaviors:[...plan.behaviors,second]};
  const result=await runReviewer(f.input);
  expect(rejections).toHaveLength(2);
  expect(rejections.every(reason=>reason.includes('OBSERVATION_SCOPE'))).toBe(true);
  expect(result.result.items).toMatchObject([{behaviorId:'B01',verdict:'passed'},{behaviorId:'B02',verdict:'passed'}]);
  expect(result.result.items.every(item=>item.observationEventIds.every(id=>result.evidence.some(event=>event.id===id&&event.behaviorId===item.behaviorId)))).toBe(true);
  expect(f.stats()).toEqual({calls:8,actions:2,closes:1});
});

test.each([
  {code:'ACTION_EVIDENCE_REQUIRED',change:{observationEventIds:[]}},
  {code:'OBSERVATION_SCOPE',change:{observationEventIds:[randomUUID()]}},
  {code:'ARTIFACT_SCOPE',change:{screenshotIds:[randomUUID()]}},
  {code:'SCHEMA_INVALID:expected',change:{expected:42}},
  {code:'SCHEMA_INVALID:report',change:{PRIVATE_FIELD_NAME:'PRIVATE_FIELD_VALUE'}},
])('invalid report reason $code is static and still allows only two correction turns',async({code,change})=>{
  let actionId='',firstRejection='';
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);
    if(n>=4){firstRejection=last?.content??'';return {name:'record_behavior',args:{...report([actionId]).items[0],...change}};}
    const data=last?JSON.parse(last.content):null;
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    actionId=data.id;return {name:'record_behavior',args:{...report([actionId]).items[0],...change}};
  });
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(firstRejection).toContain(code);
  expect(firstRejection).not.toContain('PRIVATE_FIELD');
  expect(firstRejection).not.toContain('private-review-key');
  expect(f.stats()).toEqual({calls:5,actions:1,closes:1});
});

test('malformed form arguments perform no actions and can be corrected before one real submission',async()=>{
  let observationId='',rejection='';
  const actions:string[]=[];
  const f=setup((request,n)=>{
    const last=request.messages.filter(message=>message.role==='tool').at(-1);
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2){
      observationId=JSON.parse(last!.content).observationId;
      return {name:'browser_form',args:{observationId,behaviorId:'B01',fields:[{type:'fill',ref:'e1',text:{PRIVATE_FIELD_NAME:'private-review-key'}}],submitRef:'e2'}};
    }
    if(n===3){
      rejection=last?.content??'';
      expect(actions).toEqual([]);
      return {name:'browser_form',args:{observationId,behaviorId:'B01',fields:[{type:'fill',ref:'e1',text:'测试书名'}],submitRef:'e2'}};
    }
    return {name:'record_behavior',args:report(JSON.parse(last!.content).stepObservationEventIds).items[0]};
  });
  const observation=()=>({id:randomUUID(),sessionId:f.input.browser.sessionId,url:'http://127.0.0.1:4173/',tree:'form',text:actions.includes('click')?'测试书名':'表单',
    refs:{e1:{role:'textbox',name:'书名'},e2:{role:'button',name:'添加'}},truncated:false});
  f.input.browser.open=async()=>observation();
  f.input.browser.act=async(action)=>{actions.push(action.type);return observation();};
  const result=await runReviewer(f.input);
  expect(rejection).toContain('INVALID_BROWSER_ARGUMENTS:fields.0.text');
  expect(rejection).not.toContain('PRIVATE_FIELD_NAME');
  expect(rejection).not.toContain('private-review-key');
  expect(actions).toEqual(['fill','click']);
  expect(result.evidence).toHaveLength(3);
  expect(result.usage.toolCalls).toBe(5);
  expect(f.stats()).toEqual({calls:4,actions:0,closes:1});
  assertReviewerResult(result);
});

test('a bounded form uses fresh refs after each real action and preserves every observation',async()=>{
  let current='',step=0;
  const observed=()=>({id:randomUUID(),sessionId:'pivloom-'+revisionId,url:'http://127.0.0.1:4173/',tree:'form',text:step===3?'测试书名':'表单',truncated:false,
    refs:Object.fromEntries(['书名','作者','添加'].map((name,index)=>['e'+(step*10+index+1),{name,role:index===2?'button':'textbox'}]))});
  const f=setup((request,n)=>{
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)?.content??'null');
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_form',args:{behaviorId:'B01',observationId:data.observationId,fields:[{ref:'e1',type:'fill',text:'测试书名'},{ref:'e2',type:'fill',text:'测试作者'}],submitRef:'e3'}};
    return {name:'record_behavior',args:report(data.stepObservationEventIds).items[0]};
  });
  f.input.browser.open=async()=>{const o=observed();current=o.id;return o;};
  f.input.browser.act=async(action)=>{
    expect(action.observationId).toBe(current);
    expect(action).toMatchObject({type:step<2?'fill':'click',ref:['e1','e12','e23'][step]});
    step++;const o=observed();current=o.id;return o;
  };
  const result=await runReviewer(f.input);
  expect(step).toBe(3);expect(result.evidence).toHaveLength(4);
  expect(result.result.items[0].observationEventIds).toEqual(result.evidence.slice(1).map(e=>e.id));
  expect(result.usage.toolCalls).toBe(5);
});

test.each(['ambiguous','truncated'])('form stops instead of guessing when a later target becomes %s',async(condition)=>{
  let step=0;
  const f=setup((request,n)=>{
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)?.content??'null');
    if(n===1)return {name:'browser_open',args:{}};
    return {name:'browser_form',args:{behaviorId:'B01',observationId:data.observationId,fields:[{ref:'e1',type:'fill',text:'书'}],submitRef:'e2'}};
  });
  f.input.browser.open=async()=>({id:randomUUID(),sessionId:f.input.browser.sessionId,url:'http://127.0.0.1:4173/',tree:'form',text:'',refs:{e1:{role:'textbox',name:'书名'},e2:{role:'button',name:'添加'}},truncated:false});
  f.input.browser.act=async()=>{step++;return {id:randomUUID(),sessionId:f.input.browser.sessionId,url:'http://127.0.0.1:4173/',tree:'ambiguous',text:'',refs:{e3:{role:'button',name:'添加'},...(condition==='ambiguous'?{e4:{role:'button',name:'添加'}}:{})},truncated:condition==='truncated'};};
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'CHECK_BLOCKED'});
  expect(step).toBe(1);expect(f.stats().closes).toBe(1);
});

test('later empty browser logs cannot erase an observed runtime exception',async()=>{
  let actionId='',logReads=0;
  const f=setup((request,n)=>{
    const last=request.messages.filter(m=>m.role==='tool').at(-1);let data;try{data=JSON.parse(last?.content??'null');}catch{}
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    if(n===3){actionId=data.id;return {name:'browser_logs',args:{}};}
    if(n===4)return {name:'browser_logs',args:{}};
    return {name:'record_behavior',args:report([actionId]).items[0]};
  });
  f.input.browser.logs=async()=>({errors:++logReads===1?['Uncaught error']:[]});
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats().actions).toBe(1);
});

test.each(['budget','abort'])('form respects %s between individual actions',async(mode)=>{
  let steps=0;const controller=new AbortController();
  const f=setup((request,n)=>{
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)?.content??'null');
    return n===1?{name:'browser_open',args:{}}:{name:'browser_form',args:{behaviorId:'B01',observationId:data.observationId,fields:[{ref:'e1',type:'fill',text:'书'}],submitRef:'e2'}};
  });
  const observation=()=>({id:randomUUID(),sessionId:f.input.browser.sessionId,url:'http://127.0.0.1:4173/',tree:'form',text:'',refs:{e1:{role:'textbox',name:'书名'},e2:{role:'button',name:'添加'}},truncated:false});
  f.input.browser.open=async()=>observation();
  f.input.browser.act=async()=>{steps++;controller.abort('REVIEW_TIMEOUT');return observation();};
  await expect(runReviewer({...f.input,signal:controller.signal,maxToolCalls:mode==='budget'?2:10})).rejects.toMatchObject({code:mode==='budget'?'TOOL_BUDGET_EXCEEDED':'REVIEW_TIMEOUT'});
  expect(steps).toBe(mode==='budget'?0:1);expect(f.stats().closes).toBe(1);
});
