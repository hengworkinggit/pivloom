import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createSourceStore } from '../../src/storage/source.js';
import { createArtifactStore } from '../../src/storage/artifacts.js';
import { createSourceSnapshot } from '../../src/runtime/snapshot.js';
import { createRunTokenBudget } from '../../src/runtime/token-budget.js';
import { runReview, assertVerifiedReviewReceipt } from '../../src/generation/review.js';
import { RuntimeError } from '../../src/runtime/types.js';
import type { SandboxConnection } from '../../src/runtime/workspace.js';

// Real receipt pipeline, source verification and Pi. Only remote object storage,
// sandbox transport and provider SSE are explicit external fixtures.
async function fixture(fault?:string){
  const blobs=new Map<string,Uint8Array>();
  const sources=createSourceStore({url:'http://fixture.invalid',secret:'fixture',objects:{upload:async(k,b)=>{blobs.set(k,b);},download:async(k)=>blobs.get(k)!,list:async()=>[]}});
  const files=[{path:'src/App.tsx',content:Buffer.from('export default function App(){return null}'),sha256:''}];
  files[0].sha256=createHash('sha256').update(files[0].content).digest('hex');
  const snapshot=createSourceSnapshot(files);
  const scope={ownerId:randomUUID(),projectId:randomUUID(),revisionId:randomUUID()};
  const source=await sources.save(scope,snapshot.bundle.templateVersion,files);
  const binding={runId:randomUUID(),roleRunId:randomUUID(),attempt:0,revisionId:source.revisionId,sourceHash:source.sourceHash,sandboxId:'fixture',browserSessionId:'pivloom-'+randomUUID()};
  const staging=new Map<string,Uint8Array>();let calls=0,remoteActions=0,actions=0;
  const connection:SandboxConnection={sandboxId:'fixture',kill:async()=>{},isRunning:async()=>true,renew:async()=>{},close:async()=>{},
    endpoint:async()=>({url:'http://preview-fixture.invalid',headers:{}}),read:async()=>new Uint8Array(),write:async(p,b)=>{staging.set(p,b);},
    run:async(command)=>{
      let stdoutTail='';
      if(command.startsWith('node /opt/pivloom/source-io.mjs')){
        const request=JSON.parse(Buffer.from(staging.get(command.split("'")[1])!).toString());
        stdoutTail=request.op==='read'?JSON.stringify({data:files[0].content.toString('base64')}):JSON.stringify({files:files.map(f=>f.path)});
      }else{
        remoteActions++;let data:Record<string,unknown>={};
        if(command.endsWith("'get' 'url'"))data={url:'http://127.0.0.1:4173/'};
        else if(command.endsWith("'get' 'text' 'body'"))data={text:'合成测试表单'};
        else if(command.endsWith("'snapshot' '-i'"))data={snapshot:actions&&fault==='FORM_TARGET_CHANGED'?'button 添加 [ref=e3]\nbutton 添加 [ref=e4]':'textbox 书名 [ref=e1]\nbutton 添加 [ref=e2]',refs:actions&&fault==='FORM_TARGET_CHANGED'
          ?{e3:{role:'button',name:'添加'},e4:{role:'button',name:'添加'}}
          :{e1:{role:'textbox',name:'书名'},e2:{role:'button',name:'添加'}}};
        else if(command.includes("'fill'")||command.includes("'click'")){
          actions++;
          if(fault&&fault!=='FORM_TARGET_CHANGED')throw new RuntimeError(fault,'RAW_SECRET_fixture-key private-argument');
        }
        stdoutTail=JSON.stringify({success:true,data});
      }
      return {id:randomUUID(),interrupt:async()=>{},wait:async()=>({exitCode:0,stdoutTail,stderrTail:''})};
    }};
  const modelFetch:typeof fetch=async(_url,init)=>{
    calls++;
    const request=JSON.parse(String(init?.body));
    const last=request.messages.filter((message:{role:string})=>message.role==='tool').at(-1);
    let observed:null|{observationId:string}=null;
    if(last){try{observed=JSON.parse(last.content);}catch{ /* Invalid reports return a static tool error string. */ }}
    const choice=calls===1?{name:'browser_open',args:{}}:fault==='FORM_TARGET_CHANGED'
      ?{name:'browser_form',args:{observationId:observed?.observationId,behaviorId:'B01',fields:[{ref:'e1',type:'fill',text:'测试书名'}],submitRef:'e2'}}
      :{name:'browser_click',args:{observationId:observed?.observationId,behaviorId:'B01',ref:'e2'}};
    const delta=fault?{role:'assistant',tool_calls:[{index:0,id:'call-'+calls,type:'function',function:{name:choice.name,arguments:JSON.stringify(choice.args)}}]}:{role:'assistant',content:'Completed'};
    const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:fault?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const plan={schemaVersion:1 as const,goal:'添加书名',changeSummary:'添加书名',assumptions:[],outOfScope:[],behaviors:[{id:'B01',title:'添加',precondition:'空列表',action:'添加书名',expected:'书名显示',required:true}]};
  const input:Parameters<typeof runReview>[0]={binding,sessionId:randomUUID(),expiresAt:new Date(Date.now()+600000).toISOString(),source,sources,
    artifacts:createArtifactStore({url:'http://fixture.invalid',secret:'fixture'}),
    handoff:{runId:binding.runId,fromRoleRunId:randomUUID(),toRole:'reviewer',attempt:0,baseRevisionId:null,expectedRevisionId:binding.revisionId,sourceHash:binding.sourceHash,plan,task:'检查书名',artifactIds:[]},
    sandboxConfig:{baseUrl:'http://fixture.invalid',apiKey:'fixture',image:'fixture'},
    modelConfig:{provider:'fixture',id:'fixture',api:'openai-completions',baseUrl:'https://model-fixture.invalid/v1',apiKey:'fixture-key',fetch:modelFetch,supportsImages:true},
    signal:new AbortController().signal,assertActive:async()=>{},onLeaseRenewed:async()=>{},
  };
  const boundaries={sandboxConnector:{create:async()=>connection,connect:async()=>connection},previewFetch:async()=>new Response(JSON.stringify({revisionId:source.revisionId,sourceHash:source.sourceHash}))};
  return {input,boundaries,stats:()=>({calls,remoteActions,actions})};
}

test.each(['TOOL_BUDGET_EXCEEDED','TOKEN_BUDGET_EXCEEDED','AGENT_OUTPUT_INVALID'])('%s stays a typed failure instead of being mislabeled browser blocked',async(code)=>{
  const f=await fixture();
  await expect(runReview({...f.input,...(code==='TOOL_BUDGET_EXCEEDED'?{maxToolCalls:0}:{}),...(code==='TOKEN_BUDGET_EXCEEDED'?{tokenBudget:createRunTokenBudget(1)}:{})},f.boundaries)).rejects.toMatchObject({code});
  expect(f.stats().calls).toBe(code==='AGENT_OUTPUT_INVALID'?2:0);
  expect(f.stats().remoteActions).toBe(0);
});

test.each([
  ['FORM_TARGET_CHANGED','表单控件发生变化或无法唯一定位，已停止后续操作，当前候选尚未通过检查。'],
  ['INVALID_BROWSER_ACTION','浏览器无法执行受控操作，已停止后续操作，当前候选尚未通过检查。'],
  ['COMMAND_TIMEOUT','浏览器操作超时，已停止后续操作，当前候选尚未通过检查。'],
  ['BROWSER_ORIGIN_REJECTED','浏览器离开了绑定的候选预览，已停止检查。'],
  ['UNRECOGNIZED_REMOTE_ERROR','浏览器无法访问或完成页面操作，当前候选尚未通过检查。'],
])('%s becomes a static blocked reason without leaking transport messages',async(code,reason)=>{
  const f=await fixture(code);
  const {receipt}=await runReview(f.input,f.boundaries);
  assertVerifiedReviewReceipt(receipt);
  expect(receipt.result.summary).toBe(reason);
  expect(receipt.result.items).toMatchObject([{behaviorId:'B01',verdict:'blocked',actual:reason}]);
  expect(receipt.markerVerified).toBe(false);
  expect(receipt.chromeClosed).toBe(true);
  expect(f.stats()).toMatchObject({calls:2,actions:1});
  expect(JSON.stringify(receipt)).not.toMatch(/RAW_SECRET|fixture-key|private-argument|UNRECOGNIZED_REMOTE_ERROR/);
});

test('unknown diagnostic codes use the generic blocked message without reflecting raw data',async()=>{
  const f=await fixture();
  const {receipt}=await runReview(f.input,{...f.boundaries,previewFetch:async()=>{throw new RuntimeError('CHECK_BLOCKED','RAW_SECRET_fixture-key',undefined,undefined,'UNKNOWN_RAW_SECRET_fixture-key');}});
  expect(receipt.result.summary).toBe('浏览器或检查过程未完成，当前候选尚未通过检查。');
  expect(JSON.stringify(receipt)).not.toMatch(/RAW_SECRET|fixture-key|UNKNOWN_/);
});

test('an unverified vision model leaves the candidate blocked without pretending the Reviewer saw its pixels',async()=>{
  const f=await fixture();
  f.input.modelConfig.supportsImages=false;
  const {receipt}=await runReview(f.input,f.boundaries);
  expect(receipt.result.summary).toContain('图像能力未通过实际图片测试');
  expect(receipt.result.items).toMatchObject([{verdict:'blocked',screenshotIds:[],observationEventIds:[]}]);
  expect(receipt.chromeClosed).toBe(true);
  expect(f.stats().calls).toBe(0);
});
