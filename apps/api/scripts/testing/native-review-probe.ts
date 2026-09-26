import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { PlanSchema } from '@pivloom/contracts';
import { OpenSandboxWorkspace } from '../../src/runtime/workspace.js';
import { initializeReactWorkspace, buildAndPreview } from '../../src/runtime/generation.js';
import { createSourceStore } from '../../src/storage/source.js';
import { createArtifactStore } from '../../src/storage/artifacts.js';
import { REACT_TEMPLATE_VERSION } from '../../src/runtime/snapshot.js';
import { runReview, assertVerifiedReviewReceipt } from '../../src/generation/review.js';

if(process.env.PIVLOOM_NATIVE_PROBE!=='1')throw Error('Set PIVLOOM_NATIVE_PROBE=1 for an isolated real sandbox probe');
const config={baseUrl:process.env.OPENSANDBOX_BASE_URL!,apiKey:process.env.OPENSANDBOX_API_KEY!,image:process.env.OPENSANDBOX_IMAGE!,lifetimeMs:600000,browserPrograms:true};
if(!config.baseUrl||!config.apiKey||!config.image)throw Error('Sandbox configuration missing');
const workspace=new OpenSandboxWorkspace(config);const signal=new AbortController().signal;
const runId=randomUUID(),revisionId=randomUUID();
const handle=await workspace.create({runId,signal});
console.log(JSON.stringify({stage:'created',sandboxId:handle.sandboxId}));
try{
 await initializeReactWorkspace(workspace,handle);
 const html=await readFile(new URL('../../tests/fixtures/verification/calculator.html',import.meta.url),'utf8');
 await workspace.write(handle,'index.html',Buffer.from(html.replace('<script>','<script type="module">')));
 const built=await buildAndPreview(workspace,handle,revisionId,{signal});
 await workspace.revokeWriters(handle);
 const blobs=new Map<string,Uint8Array>();const objects={upload:async(key:string,body:Uint8Array)=>{blobs.set(key,body);},download:async(key:string)=>blobs.get(key)!,list:async()=>[]};
 const sources=createSourceStore({url:'http://fixture.invalid',secret:'fixture',objects});
 const source=await sources.save({ownerId:randomUUID(),projectId:randomUUID(),revisionId},REACT_TEMPLATE_VERSION,built.files);
 if(source.sourceHash!==built.sourceHash)throw Error('Fixture source hash mismatch');
 const keys:string[]=[];for(let n=1;n<=21;n++)keys.push('Escape',...String(n),'+',...String(n),'Enter');
 const behaviors=[
  {id:'B01',title:'Twenty-one calculations',precondition:'Empty history',action:'输入二十一个算式并观察结果',expected:'Result 42 and history contains 20 entries',required:true,initialState:'fresh',steps:[{type:'open',path:'/'},{type:'key_sequence',keys},{type:'capture'}],assertions:[{kind:'target-text',target:{role:'status',name:'Result'},text:'42',match:'exact'},{kind:'target-count',target:{role:'listitem',within:{role:'list',name:'History'}},count:20}]},
  {id:'B02',title:'Clear retains history',precondition:'Previous scenario history',action:'点击清空并查看结果',expected:'Result 0 with 20 historical records',required:true,initialState:'continue',steps:[{type:'open',path:'/'},{type:'click',role:'button',name:'Clear'},{type:'capture'}],assertions:[{kind:'target-text',target:{role:'status',name:'Result'},text:'0',match:'exact'},{kind:'target-count',target:{role:'listitem',within:{role:'list',name:'History'}},count:20}]},
  {id:'B03',title:'Fresh initial state',precondition:'Fresh browser',action:'查看历史列表',expected:'Empty history in a new scenario',required:true,initialState:'fresh',steps:[{type:'open',path:'/'},{type:'capture'}],assertions:[{kind:'target-count',target:{role:'listitem',within:{role:'list',name:'History'}},count:0}]},
  {id:'B04',title:'Keypad is not result',precondition:'Fresh browser',action:'输入算式并清空',expected:'Scoped result zero even with keypad 2',required:true,initialState:'fresh',steps:[{type:'open',path:'/'},{type:'key_sequence',keys:['2','+','2','Enter','Escape']},{type:'capture'}],assertions:[{kind:'target-text',target:{role:'status',name:'Result'},text:'0',match:'exact'}]},
  {id:'B05',title:'Bad visual scope',precondition:'Fresh browser',action:'查看页面外观',expected:'Unresolvable visual setup remains blocked without deleting other checks',required:true,evidence:'visual',initialState:'fresh',steps:[{type:'open',path:'/'},{type:'capture'}],assertions:[{kind:'target-text',target:{role:'status',name:'Result',within:{role:'region',name:'Does not exist'}},text:'0',match:'exact'}]},
 ];
 const plan=PlanSchema.parse({schemaVersion:2,goal:'Verify generic replay and isolation',changeSummary:'Isolated real-browser fixture',assumptions:[],outOfScope:[],groups:behaviors.map((b,index)=>({id:'G'+(index+1),title:b.title,behaviorIds:[b.id]})),behaviors});
 let modelCalls=0;const events:unknown[]=[];const checkpoints:unknown[]=[];
 const started=performance.now();
 const checked=await runReview({binding:{runId,roleRunId:randomUUID(),attempt:0,revisionId,sourceHash:source.sourceHash,sandboxId:handle.sandboxId,browserSessionId:'pivloom-'+randomUUID()},sessionId:randomUUID(),expiresAt:handle.expiresAt,source,sources,artifacts:createArtifactStore({url:'http://fixture.invalid',secret:'fixture',objects}),
  handoff:{runId,fromRoleRunId:randomUUID(),toRole:'reviewer',attempt:0,baseRevisionId:null,expectedRevisionId:revisionId,sourceHash:source.sourceHash,plan,task:'Verify fixture',artifactIds:[]},sandboxConfig:config,
  modelConfig:{provider:'fixture',id:'fixture',api:'openai-completions',baseUrl:'https://model-fixture.invalid/v1',apiKey:'fixture',supportsImages:true,fetch:async()=>{modelCalls++;throw Error('This fixture must not call a model');}},signal,assertActive:async()=>{},onLeaseRenewed:async()=>{},onEvent:async e=>{events.push(e);},onCheckpoint:async c=>{checkpoints.push(c.item);} });
 assertVerifiedReviewReceipt(checked.receipt);
 const results=checked.receipt.result.items.map(i=>({id:i.behaviorId,verdict:i.verdict,actual:i.actual}));
 const passed=results.filter(i=>i.verdict==='passed').length,blocked=results.filter(i=>i.verdict==='blocked').length;
 const result={fixture:true,realSandbox:true,realChromium:true,storage:'in-memory external boundary',elapsedMs:Math.round(performance.now()-started),modelCalls,passed,blocked,markerVerified:checked.receipt.markerVerified,evidence:checked.receipt.evidence.length,results,events,checkpoints};
 await mkdir('.cache/verification-v2',{recursive:true});await writeFile('.cache/verification-v2/native-review.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,events:events.length,checkpoints:checkpoints.length}));
 if(passed!==4||blocked!==1||modelCalls!==0||!checked.receipt.markerVerified)throw Error('Real native review contract failed');
}finally{console.log(JSON.stringify({cleanup:await workspace.destroy(handle)}));}
