/** One isolated OpenSandbox for real Pi Reviewer + real Provider Canvas gates. */
/* eslint-disable @typescript-eslint/no-explicit-any -- This diagnostic harness reads dynamic Provider and browser JSON envelopes. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
import { PivloomDatabase } from '../../../src/data/database.ts';
import { createCredentialVault } from '../../../src/models/credentials.ts';
import { createModelFetch } from '../../../src/models/transport.ts';
import { OpenSandboxWorkspace, sandboxConnectionConfig } from '../../../src/runtime/workspace.ts';
import { RemoteBrowser } from '../../../src/runtime/browser.ts';
import { runReviewer } from '../../../src/runtime/reviewer.ts';

const output='artifacts/technical-recheck-2026-09-23/rc05-remote-negative';
await mkdir(output,{recursive:true});
const startedAt=Date.now();
const profileId='ea2e0acf-4277-4670-8280-1e6635e7b363';
const ownerId=process.env.PIVLOOM_EXECUTOR_OWNER_ID!;
if(!ownerId)throw Error('missing_isolated_provider_owner');
const db=new PivloomDatabase(process.env.DATABASE_URL!);
let row:any;
try{
  row=await db.owned(ownerId,async client=>(await client.query('SELECT p.owner_id,v.config_version,v.provider,v.base_url,v.model_id,c.ciphertext,c.nonce,c.auth_tag FROM nano.model_profiles p JOIN nano.model_profile_versions v ON v.profile_id=p.id AND v.config_version=p.current_version JOIN nano.model_credentials c ON c.profile_id=p.id AND c.config_version=v.config_version WHERE p.id=$1 AND p.owner_id=$2 AND p.deleted_at IS NULL',[profileId,ownerId])).rows[0]);
}finally{await db.close();}
if(!row)throw Error('verified_provider_profile_unavailable');
const key=createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY!).open({ciphertext:row.ciphertext,nonce:row.nonce,authTag:row.auth_tag},{ownerId,profileId,version:row.config_version});
const transport=createModelFetch(row.base_url,{timeoutMs:60_000});
const negativeTemplate=await readFile(new URL('./index.html',import.meta.url),'utf8');
const positivePage=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Canvas positive fixture</title><body style="font:16px system-ui"><h1>方向键 Canvas 正例</h1><canvas id="board" width="240" height="240" aria-label="游戏棋盘"></canvas><p id="hud"></p><script>
let direction='RIGHT',paused=false;const trail=['START'];const canvas=document.querySelector('#board'),ctx=canvas.getContext('2d');
function draw(){ctx.fillStyle='#fff';ctx.fillRect(0,0,240,240);ctx.fillStyle=paused?'#777':({UP:'#1967d2',RIGHT:'#29a453',DOWN:'#e69a17',LEFT:'#da3939'})[direction];ctx.fillRect(60,60,120,120);ctx.fillStyle='#111';ctx.font='bold 36px sans-serif';ctx.fillText(direction[0],105,132);document.querySelector('#hud').textContent='DIR:'+direction+' STATUS:'+(paused?'PAUSED':'RUNNING')+' TRAIL:'+trail.join('>')}
addEventListener('keydown',event=>{const map={ArrowUp:'UP',ArrowRight:'RIGHT',ArrowDown:'DOWN',ArrowLeft:'LEFT'};if(map[event.key]){direction=map[event.key];trail.push(direction);event.preventDefault();draw()}else if(event.code==='Space'){paused=!paused;trail.push(paused?'PAUSE':'RESUME');event.preventDefault();draw()}});draw();
</script></body></html>`;
const allModes=['positive','blank','menu','disconnected','fake-score','no-collision'] as const;
type Mode=typeof allModes[number];
const modes=(process.env.RC05_MODES?.split(',')??[...allModes]) as Mode[];
if(modes.length===0||modes.some(mode=>!allModes.includes(mode)))throw Error('invalid_modes');
const pages:Record<Mode,string>={positive:positivePage,
  blank:negativeTemplate.replace("const mode = new URLSearchParams(location.search).get('mode') || 'normal';","const mode = 'blank';"),
  menu:negativeTemplate.replace("const mode = new URLSearchParams(location.search).get('mode') || 'normal';","const mode = 'menu';"),
  disconnected:negativeTemplate.replace("const mode = new URLSearchParams(location.search).get('mode') || 'normal';","const mode = 'disconnected';"),
  'fake-score':negativeTemplate.replace("const mode = new URLSearchParams(location.search).get('mode') || 'normal';","const mode = 'fake-score';"),
  'no-collision':negativeTemplate.replace("const mode = new URLSearchParams(location.search).get('mode') || 'normal';","const mode = 'no-collision';")};
const server=`import{createServer}from'node:http';const pages=${JSON.stringify(pages)};createServer((request,response)=>{const name=decodeURIComponent(new URL(request.url,'http://localhost').pathname).slice(1);const page=pages[name];if(!page){response.writeHead(404);response.end();return}response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(page)}).listen(4173,'127.0.0.1');`;
const config={baseUrl:process.env.OPENSANDBOX_BASE_URL!,apiKey:process.env.OPENSANDBOX_API_KEY!,image:process.env.OPENSANDBOX_IMAGE!,lifetimeMs:1_500_000};
const workspace=new OpenSandboxWorkspace(config);
const controller=new AbortController(),timer=setTimeout(()=>controller.abort('RC05_REMOTE_TIMEOUT'),1_350_000);
let handle:Awaited<ReturnType<typeof workspace.create>>|undefined;
let browserVersion='',cleanupConfirmed=false,independentGet404=false;
const cases:any[]=[];
const now=()=>new Date().toISOString();
const fixtureResponse=(name:string,args:unknown,model:string)=>{
  const call={id:'rc05-'+randomUUID(),object:'chat.completion.chunk',created:1,model,
    choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'rc05-'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]};
  return new Response(`data: ${JSON.stringify(call)}\n\ndata: ${JSON.stringify({...call,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
};
const latestTool=(request:any)=>{
  const messages=request.messages??[];
  for(let index=messages.length-1;index>=0;index--){
    const message=messages[index];
    if(message?.role!=='tool'||typeof message.content!=='string')continue;
    try {const value=JSON.parse(message.content);if(value?.observationId&&value?.refs)return value;}catch{}
  }
  return null;
};
const scenario=(mode:Mode)=>({
  positive:{title:'四方向与空格',action:'依次按上、右、下、左、空格',expected:'Canvas 显示每次方向变化，最后为 LEFT 且 PAUSED，HUD 顺序为 START>UP>RIGHT>DOWN>LEFT>PAUSE',keys:['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Space']},
  blank:{title:'画布启动',action:'点击开始，按右、下、空格',expected:'画布呈现可见的蛇和食物，并随方向键改变画面，空格暂停',keys:['ArrowRight','ArrowDown','Space']},
  menu:{title:'游戏启动',action:'点击开始，按右、下、空格',expected:'开始后离开菜单并显示可控制的蛇和食物',keys:['ArrowRight','ArrowDown','Space']},
  disconnected:{title:'方向键控制',action:'点击开始，按右、下、空格',expected:'按键被应用接收，蛇移动或变向，空格切换暂停',keys:['ArrowRight','ArrowDown','Space']},
  'fake-score':{title:'吃食增长计分',action:'点击开始，按右、下',expected:'分数上升时蛇长度同步增加，Canvas 中蛇和食物真实变化',keys:['ArrowRight','ArrowDown']},
  'no-collision':{title:'撞墙结束',action:'点击开始，连续按右八次',expected:'蛇到达右墙后游戏结束，不从左侧穿墙继续',keys:Array(8).fill('ArrowRight')},
})[mode];
try{
  handle=await workspace.create({runId:randomUUID(),signal:controller.signal});
  process.stdout.write(JSON.stringify({phase:'sandbox_created',at:now(),sandboxId:handle.sandboxId,elapsedMs:Date.now()-startedAt})+'\n');
  await workspace.writeServiceFile(handle,'rc05-negative-server.mjs',server);
  await workspace.executeService(handle,'node /opt/pivloom/rc05-negative-server.mjs',{uid:0,background:true});
  const version=await workspace.executeService(handle,'agent-browser --version',{uid:0,timeoutMs:5000});
  browserVersion=version.stdoutTail.trim();
  if(browserVersion!=='agent-browser 0.38.1')throw Error('agent_browser_version_mismatch');
  let ready=false;
  for(let attempt=0;attempt<20;attempt++){
    const check=await workspace.executeService(handle,"node -e 'fetch(\"http://127.0.0.1:4173/positive\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'",{uid:0,timeoutMs:3000});
    if(check.exitCode===0){ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  if(!ready)throw Error('fixture_server_unavailable');
  process.stdout.write(JSON.stringify({phase:'browser_ready',at:now(),browserVersion,elapsedMs:Date.now()-startedAt})+'\n');
  for(const mode of modes){
    controller.signal.throwIfAborted();
    const caseStarted=Date.now(),definition=scenario(mode);
    const runId=randomUUID(),revisionId=randomUUID(),roleRunId=randomUUID(),browserSessionId='pivloom-'+randomUUID();
    const sourceHash=createHash('sha256').update(pages[mode]).digest('hex');
    const browser=new RemoteBrowser(workspace,handle,undefined,browserSessionId);
    const captured:Array<{id:string;sha256:string;base64:string}>=[];
    let scriptedTurns=0,realProviderRequests=0,maxOutboundImages=0,lastLogs:any=null;
    const nativeLogs=browser.logs.bind(browser);
    browser.logs=async()=>{lastLogs=await nativeLogs();return lastLogs;};
    const modelFetch:typeof fetch=async(url,init)=>{
      const body=String(init?.body??'');const request=JSON.parse(body),last=latestTool(request);
      scriptedTurns++;
      if(scriptedTurns===1)return fixtureResponse('browser_open',{path:'/'+mode},row.model_id);
      if(scriptedTurns===2)return fixtureResponse('browser_screenshot',{},row.model_id);
      if(mode!=='positive'&&scriptedTurns===3){
        const ref=Object.entries(last?.refs??{}).find(([,value]:any)=>value?.role==='button'&&String(value?.name).includes('开始'))?.[0];
        if(!ref||!last?.observationId)throw Error('start_ref_missing');
        return fixtureResponse('browser_click',{behaviorId:'B01',observationId:last.observationId,ref},row.model_id);
      }
      const keyTurn=mode==='positive'?3:4;
      if(scriptedTurns===keyTurn){
        if(!last?.observationId)throw Error('key_observation_missing');
        return fixtureResponse('browser_key_batch',{behaviorId:'B01',observationId:last.observationId,
          steps:definition.keys.map(key=>({key,waitMs:100}))},row.model_id);
      }
      if(scriptedTurns===keyTurn+1)return fixtureResponse('browser_screenshot',{},row.model_id);
      if(scriptedTurns===keyTurn+2)return fixtureResponse('browser_logs',{},row.model_id);
      realProviderRequests++;
      const imageCount=captured.filter(image=>body.includes(image.base64)&&body.includes('image/png')).length;
      maxOutboundImages=Math.max(maxOutboundImages,imageCount);
      return transport(url,init);
    };
    const handoff={runId,fromRoleRunId:randomUUID(),toRole:'reviewer' as const,attempt:0,baseRevisionId:null,expectedRevisionId:revisionId,sourceHash,
      plan:{schemaVersion:1 as const,goal:'验证受控 Canvas 游戏的 '+definition.title,changeSummary:'隔离 Canvas 夹具',assumptions:[],outOfScope:[],
        behaviors:[{id:'B01',title:definition.title,precondition:'已打开当前候选页面',action:definition.action,expected:definition.expected,required:true}]},
      task:'The planned browser interactions have been performed in this Reviewer session. Examine the actual before and after PNG images, the bound key-batch results, final HUD and page errors. Judge only the single B01 behavior. Browser command success, a score label or an image existing do not by themselves establish game behavior. Use record_behavior with the action observation event id and the screenshot artifact id after the action; failed means observed wrong behavior, blocked means infrastructure prevented observation. Do not assume success from the task wording.',artifactIds:[]};
    const record:any={mode,runId,revisionId,sourceHash,browserSessionId,sandboxId:handle.sandboxId,
      expected:definition.expected,keys:definition.keys,sourceBytes:Buffer.byteLength(pages[mode]),status:'NOT_RUN'};
    try{
      const result=await runReviewer({binding:{runId,roleRunId,attempt:0,revisionId,sourceHash,sandboxId:handle.sandboxId,browserSessionId},
        sessionId:randomUUID(),handoff,browser,files:[],modelConfig:{provider:'pivloom-byok',id:row.model_id,api:row.provider,baseUrl:row.base_url,
          apiKey:key,fetch:modelFetch,supportsImages:true},signal:controller.signal,requireVisionEvidence:true,maxToolCalls:20,
        timeoutMs:180_000,assertActive:async()=>controller.signal.throwIfAborted(),
        async saveScreenshot(image){const id=randomUUID();captured.push({id,sha256:image.sha256,base64:image.base64});
          await writeFile(`${output}/${mode}-${captured.length}.png`,Buffer.from(image.base64,'base64'));return{id,mimeType:image.mimeType,sha256:image.sha256};}});
      record.status='REVIEWED';record.verdict=result.result.items[0]?.verdict;
      record.actual=String(result.result.items[0]?.actual??'').replaceAll(key,'[REDACTED]');
      record.reproSteps=result.result.items[0]?.reproSteps;
      record.observationEventIds=result.result.items[0]?.observationEventIds;
      record.screenshotIds=result.result.items[0]?.screenshotIds;
      record.evidence=result.evidence.map(event=>({id:event.id,behaviorId:event.behaviorId,action:event.action,key:event.key,
        observationId:event.observationId,text:event.text,batch:event.batch}));
      record.artifacts=result.artifacts.map(artifact=>({id:artifact.id,sha256:artifact.sha256,mimeType:artifact.mimeType}));
      record.chromeClosed=result.chromeClosed;
    }catch(error){record.status='ERROR';record.errorCode=error instanceof Error?(error as any).code??error.name:'unknown';
      record.diagnosticCode=(error as any)?.diagnosticCode??null;
      try{await browser.close();}catch{} }
    record.scriptedToolDecisionTurns=mode==='positive'?5:6;
    record.modelCalls=scriptedTurns;record.realProviderRequests=realProviderRequests;
    record.maxOutboundImages=maxOutboundImages;record.screenshotHashes=captured.map(image=>image.sha256);
    record.pageErrors=Array.isArray(lastLogs?.errors)?lastLogs.errors:[];
    record.elapsedMs=Date.now()-caseStarted;
    record.passGate=record.status==='REVIEWED'&&record.realProviderRequests>0&&record.maxOutboundImages>=2
      &&record.pageErrors.length===0&&record.chromeClosed===true
      &&(mode==='positive'?record.verdict==='passed':record.verdict==='failed'||record.verdict==='blocked');
    cases.push(record);
    await writeFile(`${output}/progress.json`,JSON.stringify({cases},null,2)+'\n');
    process.stdout.write(JSON.stringify({phase:'case',mode,status:record.status,verdict:record.verdict??null,
      errorCode:record.errorCode??null,diagnosticCode:record.diagnosticCode??null,
      realProviderRequests,maxOutboundImages,passGate:record.passGate,elapsedMs:record.elapsedMs})+'\n');
  }
}catch(error){cases.push({phase:'setup_or_loop',status:'ERROR',errorCode:error instanceof Error?(error as any).code??error.name:'unknown'});
  process.stdout.write(JSON.stringify({phase:'fatal',errorCode:cases.at(-1).errorCode,elapsedMs:Date.now()-startedAt})+'\n');}
finally{
  clearTimeout(timer);
  if(handle){
    cleanupConfirmed=(await workspace.destroy(handle)).confirmed;
    try{
      const independent=await Sandbox.connect({connectionConfig:sandboxConnectionConfig(config),sandboxId:handle.sandboxId,readyTimeoutSeconds:5});
      await independent.getInfo();await independent.close();
    }catch(error){independentGet404=error instanceof SandboxApiException&&error.statusCode===404;}
  }
  const report={case:'RC-05 real OpenSandbox + Pi Reviewer + real Provider controlled Canvas positive/negative',runtimeSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    profile:{provider:row.provider,baseUrl:row.base_url,modelId:row.model_id,configVersion:row.config_version},
    browserVersion,piVersion:'0.86.1',sandboxId:handle?.sandboxId??null,cases,cleanupConfirmed,independentGet404,
    databaseWrites:0,storageWrites:0,fixtureBoundary:'Only the initial tool-choice turns are scripted. OpenSandbox, agent-browser keyboard/batch/screenshot, Pi image ToolResults and the final Provider verdict are real. No generated Snake or production project Run.'};
  await writeFile(`${output}/result.json`,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({phase:'done',cleanupConfirmed,independentGet404,passed:cases.filter(item=>item.passGate).length,
    total:cases.length,elapsedMs:Date.now()-startedAt})+'\n');
}
