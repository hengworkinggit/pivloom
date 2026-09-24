/** Local Chrome supplement: same RemoteBrowser + Pi Reviewer + real Provider, no OpenSandbox. */
/* eslint-disable @typescript-eslint/no-explicit-any -- This diagnostic harness reads dynamic Provider and browser JSON envelopes. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { PivloomDatabase } from '../../../src/data/database.ts';
import { createCredentialVault } from '../../../src/models/credentials.ts';
import { createModelFetch } from '../../../src/models/transport.ts';
import { RemoteBrowser } from '../../../src/runtime/browser.ts';
import { runReviewer } from '../../../src/runtime/reviewer.ts';

const ownerId=process.env.PIVLOOM_EXECUTOR_OWNER_ID!,profileId='ea2e0acf-4277-4670-8280-1e6635e7b363';
const mode=process.env.RC05_MODE??'blank';
if(!['blank','menu','disconnected','fake-score','no-collision'].includes(mode))throw Error('invalid_mode');
const output='artifacts/technical-recheck-2026-09-23/rc05-local-negative';
await mkdir(output,{recursive:true});
const db=new PivloomDatabase(process.env.DATABASE_URL!);
let row:any;
try{row=await db.owned(ownerId,async client=>(await client.query('SELECT p.owner_id,v.config_version,v.provider,v.base_url,v.model_id,c.ciphertext,c.nonce,c.auth_tag FROM nano.model_profiles p JOIN nano.model_profile_versions v ON v.profile_id=p.id AND v.config_version=p.current_version JOIN nano.model_credentials c ON c.profile_id=p.id AND c.config_version=v.config_version WHERE p.id=$1 AND p.owner_id=$2 AND p.deleted_at IS NULL',[profileId,ownerId])).rows[0]);}
finally{await db.close();}
if(!row)throw Error('verified_provider_profile_unavailable');
const key=createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY!).open({ciphertext:row.ciphertext,nonce:row.nonce,authTag:row.auth_tag},{ownerId,profileId,version:row.config_version});
const transport=createModelFetch(row.base_url,{timeoutMs:60_000});
const handle={sandboxId:'local-'+randomUUID(),expiresAt:new Date(Date.now()+300_000).toISOString()};
const browserBinDir=process.env.RC05_AGENT_BROWSER_BIN_DIR;
const workspace={
  async executeService(_handle:unknown,command:string,options:{timeoutMs?:number}={}){
    const child=spawn('/bin/sh',['-c',command],{env:{...process.env,
      PATH:browserBinDir?browserBinDir+':'+process.env.PATH:process.env.PATH}});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});
    child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
    const exitCode=await new Promise<number>((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('local_browser_command_timeout'));},options.timeoutMs??15_000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);resolve(code??1);});
    });
    return{exitCode,stdoutTail:stdout.slice(-16000),stderrTail:stderr.slice(-8000)};
  },
  async readArtifact(_handle:unknown,name:string){return readFile('/tmp/pivloom-browser/'+name);},
};
const browserVersion=(await workspace.executeService(handle,'agent-browser --version')).stdoutTail.trim();
if(browserVersion!=='agent-browser 0.38.1')throw Error('agent_browser_version_mismatch');
const sessionId='pivloom-'+randomUUID(),browser=new RemoteBrowser(workspace as any,handle,undefined,sessionId);
const page=await readFile(new URL('./index.html',import.meta.url),'utf8');
const sourceHash=createHash('sha256').update(page+mode).digest('hex');
const runId=randomUUID(),revisionId=randomUUID(),roleRunId=randomUUID(),controller=new AbortController();
const captured:Array<{id:string;sha256:string;base64:string}>=[];
let turns=0,realProviderRequests=0,maxOutboundImages=0,lastLogs:any=null;
const nativeLogs=browser.logs.bind(browser);browser.logs=async()=>{lastLogs=await nativeLogs();return lastLogs;};
const keys=mode==='no-collision'?Array(8).fill('ArrowRight'):
  mode==='fake-score'?['ArrowRight','ArrowDown']:['ArrowRight','ArrowDown','Space'];
const expected=({blank:'画布呈现可见的蛇和食物，并随方向键改变画面，空格暂停',menu:'开始后离开菜单并显示可控制的蛇和食物',
  disconnected:'按键被应用接收，蛇移动或变向，空格切换暂停','fake-score':'分数上升时蛇长度同步增加，Canvas 中蛇和食物真实变化',
  'no-collision':'蛇到达右墙后游戏结束，不从左侧穿墙继续'} as Record<string,string>)[mode];
const fixture=(name:string,args:unknown)=>{
  const call={id:'rc05-'+randomUUID(),object:'chat.completion.chunk',created:1,model:row.model_id,
    choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'rc05-'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]};
  return new Response(`data: ${JSON.stringify(call)}\n\ndata: ${JSON.stringify({...call,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
};
const latestRefs=(request:any)=>{
  for(const message of [...(request.messages??[])].reverse())if(message?.role==='tool'&&typeof message.content==='string'){
    try{const value=JSON.parse(message.content);if(value?.observationId&&value?.refs)return value;}catch{}
  }
  return null;
};
const modelFetch:typeof fetch=async(url,init)=>{
  const body=String(init?.body??''),request=JSON.parse(body),last=latestRefs(request);
  turns++;
  if(turns===1)return fixture('browser_open',{path:'/?mode='+mode});
  if(turns===2)return fixture('browser_screenshot',{});
  if(turns===3){const ref=Object.entries(last?.refs??{}).find(([,value]:any)=>value?.role==='button'&&String(value?.name).includes('开始'))?.[0];
    if(!ref||!last?.observationId)throw Error('start_ref_missing');
    return fixture('browser_click',{behaviorId:'B01',observationId:last.observationId,ref});}
  if(turns===4){if(!last?.observationId)throw Error('key_observation_missing');
    return fixture('browser_key_batch',{behaviorId:'B01',observationId:last.observationId,steps:keys.map(key=>({key,waitMs:100}))});}
  if(turns===5)return fixture('browser_screenshot',{});
  if(turns===6)return fixture('browser_logs',{});
  realProviderRequests++;
  maxOutboundImages=Math.max(maxOutboundImages,captured.filter(image=>body.includes(image.base64)&&body.includes('image/png')).length);
  return transport(url,init);
};
const handoff={runId,fromRoleRunId:randomUUID(),toRole:'reviewer' as const,attempt:0,baseRevisionId:null,expectedRevisionId:revisionId,sourceHash,
  plan:{schemaVersion:1 as const,goal:'验证受控 Canvas '+mode,changeSummary:'隔离夹具',assumptions:[],outOfScope:[],
    behaviors:[{id:'B01',title:'Canvas '+mode,precondition:'当前候选已打开',action:'点击开始并发送真实键盘动作',expected,required:true}]},
  task:'The browser has just run the planned actions in this session. Compare before and after PNGs and the actual HUD; judge whether the behavior works. A successful press command, text score, or a PNG merely existing is not proof. Use the bound key-batch observation event ID and post-action screenshot artifact ID in record_behavior. Mark failed for observed incorrect behavior and blocked only for infrastructure failure.',artifactIds:[]};
const started=Date.now();let report:any={mode,status:'NOT_RUN',runId,revisionId,sourceHash,browserSessionId:sessionId};
try{
  const result=await runReviewer({binding:{runId,roleRunId,attempt:0,revisionId,sourceHash,sandboxId:handle.sandboxId,browserSessionId:sessionId},
    sessionId:randomUUID(),handoff,browser,files:[],modelConfig:{provider:'pivloom-byok',id:row.model_id,api:row.provider,baseUrl:row.base_url,
      apiKey:key,fetch:modelFetch,supportsImages:true},signal:controller.signal,requireVisionEvidence:true,maxToolCalls:20,timeoutMs:180_000,
    assertActive:async()=>controller.signal.throwIfAborted(),
    async saveScreenshot(image){const id=randomUUID();captured.push({id,sha256:image.sha256,base64:image.base64});
      await writeFile(`${output}/${mode}-${captured.length}.png`,Buffer.from(image.base64,'base64'));return{id,mimeType:image.mimeType,sha256:image.sha256};}});
  report={...report,status:'REVIEWED',verdict:result.result.items[0]?.verdict,actual:String(result.result.items[0]?.actual??'').replaceAll(key,'[REDACTED]'),
    observationEventIds:result.result.items[0]?.observationEventIds,screenshotIds:result.result.items[0]?.screenshotIds,
    evidence:result.evidence.map(event=>({id:event.id,behaviorId:event.behaviorId,action:event.action,observationId:event.observationId,
      text:event.text,batch:event.batch})),artifacts:result.artifacts,chromeClosed:result.chromeClosed};
}catch(error){report={...report,status:'ERROR',errorCode:error instanceof Error?(error as any).code??error.name:'unknown',
  diagnosticCode:(error as any)?.diagnosticCode??null};try{await browser.close();}catch{}}
finally{
  report={...report,expected,keys,browserVersion,modelCalls:turns,realProviderRequests,maxOutboundImages,
    pageErrors:Array.isArray(lastLogs?.errors)?lastLogs.errors:[],screenshotHashes:captured.map(image=>image.sha256),elapsedMs:Date.now()-started,
    boundary:'Local agent-browser0.38.1 and RemoteBrowser/real Pi Reviewer/real Provider. No OpenSandbox, DB writes, Storage writes or generated Snake.'};
  await writeFile(`${output}/${mode}.json`,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({mode,status:report.status,verdict:report.verdict??null,errorCode:report.errorCode??null,
    diagnosticCode:report.diagnosticCode??null,realProviderRequests,maxOutboundImages,elapsedMs:report.elapsedMs})+'\n');
}
