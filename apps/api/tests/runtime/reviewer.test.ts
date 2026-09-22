import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { runReviewer, assertReviewerResult, type ReviewBrowser } from '../../src/runtime/reviewer.js';
import { classifyReviewerModelFailure } from '../../src/runtime/reviewer.js';
import { MODEL_REQUEST_TIMEOUT_MS, PROVIDER_RETRY_POLICY, REVIEW_ATTEMPT_TIMEOUT_MS, RUN_DEADLINE_MS } from '../../src/runtime/budgets.js';

test('the run and Reviewer ceilings leave room for the measured three-role chain',()=>{
  expect(RUN_DEADLINE_MS).toBeGreaterThanOrEqual(1_200_000);
  expect(REVIEW_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(480_000);
  expect(MODEL_REQUEST_TIMEOUT_MS).toBeGreaterThan(57_000);
  expect(MODEL_REQUEST_TIMEOUT_MS).toBeLessThan(REVIEW_ATTEMPT_TIMEOUT_MS);
  expect(REVIEW_ATTEMPT_TIMEOUT_MS).toBeLessThan(RUN_DEADLINE_MS);
});

test.each([
  ['attempt deadline already fired',{deadlineAborted:true,grantedTimeoutClipped:false,expired:false}],
  ['request budget clipped by the deadline',{deadlineAborted:false,grantedTimeoutClipped:true,expired:false}],
  ['attempt clock expired before the terminal event',{deadlineAborted:false,grantedTimeoutClipped:false,expired:true}],
])('a model turn stopped by %s is a review deadline, not a provider failure',(_label,state)=>{
  expect(classifyReviewerModelFailure(state).code).toBe('REVIEW_TIMEOUT');
});

test('only an in-budget provider failure is reported as a provider error',()=>{
  const timeout=classifyReviewerModelFailure({deadlineAborted:false,grantedTimeoutClipped:false,expired:false,errorMessage:'Request timed out after 120s'});
  expect(timeout.code).toBe('MODEL_REQUEST_TIMEOUT');
  const other=classifyReviewerModelFailure({deadlineAborted:false,grantedTimeoutClipped:false,expired:false,errorMessage:'Provider returned a malformed payload'});
  expect(other.code).toBe('MODEL_FAILED');
});

// External model HTTP and browser protocol fixtures; actual Pi loop, permission
// allowlist and evidence validation execute without mocking internal modules.
const revisionId = randomUUID(), sourceHash = 'a'.repeat(64);
const plan = { schemaVersion: 1 as const, goal: '新增书籍', changeSummary: '新增书籍', assumptions: [], outOfScope: ['不发送邮件'],
  behaviors: [{ id: 'B01', title: '添加', precondition: '空书单', action: '填写并添加', expected: '出现书名', required: true }] };
function setup(turn: (request: { messages: Array<{ role: string; content: string }> }, n: number) => { name: string; args: unknown }) {
  let calls = 0, actions = 0, closes = 0;
  const observation = () => ({ id: randomUUID(), sessionId: 'pivloom-'+revisionId, url:'http://127.0.0.1:4173/', tree:'button 添加 [ref=e1]', text: actions ? '测试书名' : '空书单', refs:{ e1:{ role:'button', name:'添加' } }, truncated: false });
  const browser: ReviewBrowser = { sessionId:'pivloom-'+revisionId, open:async()=>observation(), observe:async()=>observation(),
    act:async()=>{actions++; return observation();}, logs:async()=>({errors:[]}), close:async()=>{closes++; return {confirmed:true};},
    screenshot:async()=>({base64:'',sha256:'b'.repeat(64),mimeType:'image/png'}) };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const choice = turn(JSON.parse(String(init?.body)), ++calls);
    const chunk = { id:'fixture-'+calls,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',reasoning_content:'PRIVATE_HIDDEN_REASONING',tool_calls:[{index:0,id:'call-'+calls,type:'function',function:{name:choice.name,arguments:JSON.stringify(choice.args)}}]},finish_reason:null}] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const runId = randomUUID(),roleRunId=randomUUID();
  const input = { binding:{runId,roleRunId,attempt:0,revisionId,sourceHash,sandboxId:'fixture-sandbox',browserSessionId:browser.sessionId},
    sessionId:randomUUID(), handoff:{runId,fromRoleRunId:randomUUID(),toRole:'reviewer' as const,attempt:0,baseRevisionId:null,expectedRevisionId:revisionId,sourceHash,plan,task:'检查新增书籍',artifactIds:[]},
    browser,files:[{path:'src/App.tsx',content:'export default function App() {}'}],modelConfig:{provider:'review-fixture',id:'fixture',api:'openai-completions' as const,baseUrl:'https://fixture.invalid/v1',apiKey:'private-review-key',fetch},
    signal:new AbortController().signal,assertActive:async()=>{},saveScreenshot:async()=>({id:randomUUID(),mimeType:'image/png' as const,sha256:'b'.repeat(64)}) };
  return { input, stats:()=>({calls,actions,closes}) };
}
const report=(ids:string[])=>({revisionId,sourceHash,items:[{behaviorId:'B01',verdict:'passed',expected:'出现书名',actual:'已出现',observationEventIds:ids,screenshotIds:[],reproSteps:['点击添加']}],summary:'通过'});
test('a fabricated passing report cannot replace actual browser actions and observations',async()=>{
  const f=setup(()=>({name:'submit_review',args:report([randomUUID()])}));
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats()).toEqual({calls:2,actions:0,closes:1});
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
  const result=await runReviewer(f.input);
  expect(result.result.items[0].verdict).toBe('passed');
  expect(f.stats()).toEqual({calls:3,actions:0,closes:1});
  assertReviewerResult(result);
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
  expect(f.stats()).toEqual({calls:3,actions:0,closes:1});
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

test('the whole Reviewer attempt has a deadline, including a stalled model stream',async()=>{
  const f=setup(()=>({name:'browser_open',args:{}})), controller=new AbortController();
  f.input.modelConfig.fetch=async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
    const signal=init?.signal;
    if(signal?.aborted)reject(new Error('aborted'));
    else signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  });
  const pending=runReviewer({...f.input,signal:controller.signal,timeoutMs:30});
  const result=pending.then(()=> 'unexpected success',error=>error.code);
  try{
    expect(await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('NO_ATTEMPT_DEADLINE'),150))])).toBe('REVIEW_TIMEOUT');
  }finally{controller.abort();await result;}
  expect(f.stats().closes).toBe(1);
});

test('expiry while persisting tool.start prevents starting the browser operation',async()=>{
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

test('historical browser observations are compact on the model wire while saved evidence stays complete',async()=>{
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
  expect(history).toHaveLength(2);
  expect(history[0]).not.toHaveProperty('tree');
  expect(history[0]).not.toHaveProperty('refs');
  expect(String(history[0].text).length).toBeLessThanOrEqual(800);
  expect(memory?.observations[0]).toMatchObject({contextCompacted:true,truncated:true,id:result.evidence[0].id});
  expect(history.at(-1)).toMatchObject({tree:'button 添加 [ref=e1]',refs:{e1:{role:'button',name:'添加'}}});
  expect(result.evidence[0].text).toBe('initial '.repeat(1000));
  expect(result.evidence.at(-1)?.text).toBe('result '.repeat(1000));
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

test('validated behavior progress survives context rotation and completes without replaying actions',async()=>{
  let remembered:unknown;
  const second={...plan.behaviors[0],id:'B02',title:'再次检查',expected:'仍有书名'};
  const f=setup((request,n)=>{
    const data=JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1)?.content??'null');
    const memory=request.messages.filter(m=>m.role==='user').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(m=>m?.type==='review_memory');
    if(n===1)return {name:'browser_open',args:{}};
    if(n===2)return {name:'browser_click',args:{behaviorId:'B01',observationId:data.observationId,ref:'e1'}};
    if(n===3)return {name:'record_behavior',args:report([data.id]).items[0]};
    if(n===4)return {name:'browser_observe',args:{}};
    if(n===5){remembered=memory?.completedBehaviors;return {name:'browser_click',args:{behaviorId:'B02',observationId:data.observationId,ref:'e1'}};}
    if(n===6)return {name:'record_behavior',args:{...report([data.id]).items[0],behaviorId:'B02',expected:second.expected}};
    throw Error('Unexpected model turn after all behaviors recorded');
  });
  f.input.handoff.plan={...plan,behaviors:[...plan.behaviors,second]};
  const result=await runReviewer(f.input);
  expect(remembered).toMatchObject([{behaviorId:'B01',verdict:'passed',actual:'已出现'}]);
  expect(result.result.items.map(i=>i.behaviorId)).toEqual(['B01','B02']);
  expect(f.stats()).toEqual({calls:6,actions:2,closes:1});
  assertReviewerResult(result);
});

test('exhausting the screenshot quota is recoverable and cannot fail an otherwise valid check',async()=>{
  let actionId='';
  const f=setup((request,n)=>{
    if(n<=7)return {name:'browser_screenshot',args:{}};
    const parse=()=>{const last=request.messages.filter(m=>m.role==='tool').at(-1);const raw=last?last.content:'';try{return JSON.parse(raw);}catch{return null;}};
    if(n===8)return {name:'browser_open',args:{path:'/'}};
    if(n===9)return {name:'browser_click',args:{behaviorId:'B01',observationId:parse().observationId,ref:'e1'}};
    actionId=parse().id;
    return {name:'record_behavior',args:report([actionId]).items[0]};
  });
  const result=await runReviewer(f.input);
  expect(result.result.items[0].verdict).toBe('passed');
  // One screenshot over the six-artifact ceiling is refused, then the check
  // continues: the quota is a per-attempt ceiling, not a browser failure.
  expect(result.artifacts).toHaveLength(6);
  expect(f.stats().actions).toBe(1);
});

test('progress cannot fabricate evidence or complete a behavior outside the plan',async()=>{
  const f=setup(()=>({name:'record_behavior',args:report([randomUUID()]).items[0]}));
  await expect(runReviewer(f.input)).rejects.toMatchObject({code:'AGENT_OUTPUT_INVALID'});
  expect(f.stats()).toEqual({calls:2,actions:0,closes:1});
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

test.each([
  {code:'ACTION_EVIDENCE_REQUIRED',change:{observationEventIds:[]}},
  {code:'OBSERVATION_SCOPE',change:{observationEventIds:[randomUUID()]}},
  {code:'ARTIFACT_SCOPE',change:{screenshotIds:[randomUUID()]}},
  {code:'SCHEMA_INVALID:expected',change:{expected:42}},
  {code:'SCHEMA_INVALID:report',change:{PRIVATE_FIELD_NAME:'PRIVATE_FIELD_VALUE'}},
])('invalid report reason $code is static and still allows only one correction',async({code,change})=>{
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
  expect(f.stats()).toEqual({calls:4,actions:1,closes:1});
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
