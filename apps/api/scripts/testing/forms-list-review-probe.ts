import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { PlanSchema } from '@pivloom/contracts';
import { OpenSandboxWorkspace } from '../../src/runtime/workspace.js';
import { RemoteBrowser } from '../../src/runtime/browser.js';
import { initializeReactWorkspace, buildAndPreview } from '../../src/runtime/generation.js';
import { createSourceStore } from '../../src/storage/source.js';
import { createArtifactStore } from '../../src/storage/artifacts.js';
import { REACT_TEMPLATE_VERSION } from '../../src/runtime/snapshot.js';
import { runReview, assertVerifiedReviewReceipt } from '../../src/generation/review.js';

if(process.env.PIVLOOM_NATIVE_PROBE!=='1')throw Error('Set PIVLOOM_NATIVE_PROBE=1 for an isolated real sandbox probe');
const config={baseUrl:process.env.OPENSANDBOX_BASE_URL!,apiKey:process.env.OPENSANDBOX_API_KEY!,image:process.env.OPENSANDBOX_IMAGE!,lifetimeMs:600_000,browserPrograms:true};
if(!config.baseUrl||!config.apiKey||!config.image)throw Error('Sandbox configuration missing');
const controller=new AbortController(),signal=controller.signal;
const deadline=setTimeout(()=>controller.abort('PROBE_TIMEOUT'),480_000);deadline.unref();
const workspace=new OpenSandboxWorkspace(config),runId=randomUUID(),revisionId=randomUUID();
const handle=await workspace.create({runId,signal});
const outputPath='.cache/verification-v2/forms-list-review.json';
let measuring=false,serviceCommands=0,nativePrograms=0,browserCommands=0;
const executeService=OpenSandboxWorkspace.prototype.executeService;
const executeProgram=RemoteBrowser.prototype.executeProgram;
// Measurement only: both wrappers delegate unchanged to the real transports.
OpenSandboxWorkspace.prototype.executeService=async function(...args){if(measuring)serviceCommands++;return executeService.apply(this,args);};
RemoteBrowser.prototype.executeProgram=async function(...args){const result=await executeProgram.apply(this,args);if(measuring){nativePrograms++;browserCommands+=result.commandCount;}return result;};
console.log(JSON.stringify({stage:'created',sandboxId:handle.sandboxId}));
let result:Record<string,unknown>|undefined;
try{
  await initializeReactWorkspace(workspace,handle);
  await workspace.write(handle,'index.html',await readFile(new URL('../../tests/fixtures/verification/forms-list.html',import.meta.url)));
  const built=await buildAndPreview(workspace,handle,revisionId,{signal});await workspace.revokeWriters(handle);
  const blobs=new Map<string,Uint8Array>();
  const objects={upload:async(key:string,body:Uint8Array)=>{blobs.set(key,body);},download:async(key:string)=>blobs.get(key)!,list:async()=>[]};
  const sources=createSourceStore({url:'http://fixture.invalid',secret:'fixture',objects});
  const source=await sources.save({ownerId:randomUUID(),projectId:randomUUID(),revisionId},REACT_TEMPLATE_VERSION,built.files);
  if(source.sourceHash!==built.sourceHash)throw Error('Fixture source hash mismatch');
  const tasks={role:'list',name:'Tasks'};
  const behaviors=[
    {id:'B01',title:'Add form entries',initialState:'fresh',precondition:'Empty task list',action:'填写表单并添加两个条目',expected:'Tasks contains Alpha and Beta, exactly two items',steps:[{type:'open',path:'/'},{type:'fill',role:'textbox',name:'Task title',text:'Alpha'},{type:'click',role:'button',name:'Add task'},{type:'fill',role:'textbox',name:'Task title',text:'Beta'},{type:'click',role:'button',name:'Add task'},{type:'capture'}],assertions:[{kind:'target-count',target:{role:'listitem',within:tasks},count:2},{kind:'target-text',target:{role:'status',name:'Task count'},text:'2 items',match:'exact'}]},
    {id:'B02',title:'Filter only the task list',initialState:'continue',precondition:'Alpha and Beta exist',action:'完成Alpha并筛选未完成条目',expected:'Only Beta remains in Tasks while Activity still mentions Alpha',steps:[{type:'open',path:'/'},{type:'click',role:'button',name:'Complete Alpha'},{type:'select',role:'combobox',name:'Filter tasks',value:'active'},{type:'capture'}],assertions:[{kind:'target-count',target:{role:'listitem',within:tasks},count:1},{kind:'target-count',target:{role:'listitem',name:'Task Beta',within:tasks},count:1},{kind:'target-count',target:{role:'listitem',name:'Task Alpha',within:tasks},count:0},{kind:'target-text',target:{role:'list',name:'Activity'},text:'Completed Alpha',match:'contains'}]},
    {id:'B03',title:'Use controls created after interaction',initialState:'continue',precondition:'Two stored tasks',action:'显示动态快捷表单并添加Gamma',expected:'Dynamically created textbox and button add Gamma, giving three tasks',steps:[{type:'open',path:'/'},{type:'select',role:'combobox',name:'Filter tasks',value:'all'},{type:'click',role:'button',name:'Reveal quick add'},{type:'wait',ms:350},{type:'fill',role:'textbox',name:'Quick task title',text:'Gamma'},{type:'click',role:'button',name:'Add quick task'},{type:'capture'}],assertions:[{kind:'target-count',target:{role:'listitem',within:tasks},count:3},{kind:'target-text',target:{role:'status',name:'Latest action'},text:'Added Gamma',match:'exact'}]},
    {id:'B04',title:'Reload preserves task state',initialState:'continue',precondition:'Alpha completed, Beta and Gamma active',action:'刷新页面并核对持久数据',expected:'Three tasks and the completed Alpha state survive reload',steps:[{type:'open',path:'/'},{type:'reload'},{type:'capture'}],assertions:[{kind:'target-count',target:{role:'listitem',within:tasks},count:3},{kind:'target-count',target:{role:'button',name:'Undo Alpha',within:tasks},count:1},{kind:'target-count',target:{role:'listitem',name:'Task Gamma',within:tasks},count:1}]},
    {id:'B05',title:'Fresh narrow viewport remains interactive',initialState:'fresh',precondition:'Previous scenario stored three tasks',action:'以390px新场景填写表单并添加Delta',expected:'Fresh state contains only Delta and the submitted textbox is empty at 390px',steps:[{type:'open',path:'/'},{type:'resize',width:390,height:844},{type:'fill',role:'textbox',name:'Task title',text:'Delta'},{type:'click',role:'button',name:'Add task'},{type:'capture'}],assertions:[{kind:'target-count',target:{role:'listitem',within:tasks},count:1},{kind:'target-count',target:{role:'listitem',name:'Task Delta',within:tasks},count:1},{kind:'target-value',target:{role:'textbox',name:'Task title'},value:''}]},
  ].map(behavior=>({...behavior,required:true,evidence:'text'}));
  const plan=PlanSchema.parse({schemaVersion:2,verificationMode:'programs',goal:'Generic forms, lists and dynamic controls',changeSummary:'Isolated real-browser verification',assumptions:[],outOfScope:['Visual appearance is not judged by this functional probe'],groups:behaviors.map((behavior,index)=>({id:`G${index+1}`,title:behavior.title,behaviorIds:[behavior.id]})),behaviors});
  let modelCalls=0;const events:unknown[]=[];
  measuring=true;const started=performance.now();
  const checked=await runReview({binding:{runId,roleRunId:randomUUID(),attempt:0,revisionId,sourceHash:source.sourceHash,sandboxId:handle.sandboxId,browserSessionId:`pivloom-${randomUUID()}`},sessionId:randomUUID(),expiresAt:handle.expiresAt,source,sources,
    artifacts:createArtifactStore({url:'http://fixture.invalid',secret:'fixture',objects}),handoff:{runId,fromRoleRunId:randomUUID(),toRole:'reviewer',attempt:0,baseRevisionId:null,expectedRevisionId:revisionId,sourceHash:source.sourceHash,plan,task:'Verify forms, list and dynamic controls',artifactIds:[]},
    sandboxConfig:config,modelConfig:{provider:'fixture',id:'fixture',api:'openai-completions',baseUrl:'https://model-fixture.invalid/v1',apiKey:'fixture',supportsImages:false,fetch:async()=>{modelCalls++;throw Error('This functional probe must not call a model');}},
    signal,assertActive:async()=>{},onLeaseRenewed:async()=>{},onEvent:async event=>{events.push(event);} });
  const elapsedMs=Math.round(performance.now()-started);measuring=false;assertVerifiedReviewReceipt(checked.receipt);
  const results=checked.receipt.result.items.map(item=>({id:item.behaviorId,verdict:item.verdict,actual:item.actual,evidenceIds:item.observationEventIds}));
  result={fixture:true,realSandbox:true,realChromium:true,sandboxId:handle.sandboxId,storage:'in-memory external boundary',sourceHash:source.sourceHash,revisionId,elapsedMs,modelCalls,serviceCommands,nativePrograms,browserCommands,markerVerified:checked.receipt.markerVerified,verification:checked.receipt.verification,results,evidence:checked.receipt.evidence,events};
  console.log(JSON.stringify({...result,evidence:checked.receipt.evidence.length,events:events.length}));
  if(results.length!==5||results.some(item=>item.verdict!=='passed')||modelCalls!==0||!checked.receipt.markerVerified)throw Error('Real forms/list review failed');
}finally{
  measuring=false;OpenSandboxWorkspace.prototype.executeService=executeService;RemoteBrowser.prototype.executeProgram=executeProgram;
  clearTimeout(deadline);
  const cleanup=await workspace.destroy(handle);console.log(JSON.stringify({cleanup}));
  if(result){result.cleanup=cleanup;await mkdir('.cache/verification-v2',{recursive:true});await writeFile(outputPath,JSON.stringify(result,null,2));}
}
