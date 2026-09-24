/** RC-05: one real OpenSandbox, native seven-key batch, then cancel a long batch. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
import { OpenSandboxWorkspace, sandboxConnectionConfig } from '../../../src/runtime/workspace.ts';
import { RemoteBrowser } from '../../../src/runtime/browser.ts';

const output='artifacts/technical-recheck-2026-09-23/rc05-key-cancel';
await mkdir(output,{recursive:true});
const cancelOnly=process.env.RC05_CANCEL_ONLY==='1';
const collectorOrigin='http://172.17.0.1:28055';
const sshTarget=process.env.RC05_SSH_TARGET??'root@69.5.7.187';
const sshControlPath=process.env.RC05_SSH_CONTROL_PATH??'/tmp/pivloom-dev-ssh.sock';
const execFileAsync=promisify(execFile);
const hostGet=async(path:string)=>{
  const command=`curl -fsS --max-time 20 ${collectorOrigin}${path}`;
  const result=await execFileAsync('ssh',['-S',sshControlPath,'-o','ControlMaster=auto','-o','BatchMode=yes',sshTarget,command],{timeout:23_000});
  return JSON.parse(result.stdout) as Record<string,unknown> | Array<Record<string,unknown>>;
};
const hostEvents=async()=>{
  const events=await hostGet('/events');
  if(!Array.isArray(events))throw Error('host_event_log_invalid');
  return events as Array<{mode:string;phase:string;key:string;at:number;receivedAt:number}>;
};
const page=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Canvas key cancellation fixture</title><body style="font:16px system-ui"><h1>Canvas 键盘验收</h1><canvas id="board" width="240" height="240" aria-label="键盘画布"></canvas><p id="hud"></p><script>
const mode=location.pathname.slice(1),canvas=document.querySelector('#board'),ctx=canvas.getContext('2d');const trail=['START'];let paused=false,last='START';
function draw(){ctx.fillStyle='#fff';ctx.fillRect(0,0,240,240);ctx.fillStyle=paused?'#666':last==='Backspace'?'#e27732':last==='Enter'?'#397fd1':'#31a55b';ctx.fillRect(50,50,140,140);ctx.fillStyle='#111';ctx.font='bold 36px sans-serif';ctx.fillText(last==='Backspace'?'B':last==='Enter'?'E':last==='Space'?'P':last.startsWith('Arrow')?last.slice(5,6):'S',108,132);document.querySelector('#hud').textContent='MODE:'+mode+' STATUS:'+(paused?'PAUSED':'RUNNING')+' TRAIL:'+trail.join('>')}
const send=(phase,key)=>fetch('/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode,phase,key,at:Date.now()})}).catch(()=>{});
addEventListener('keydown',event=>{if(!['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Space','Enter','Backspace'].includes(event.code))return;event.preventDefault();last=event.code;if(last==='Space')paused=!paused;trail.push(last);send('down',last);draw()});
addEventListener('keyup',event=>{if(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Space','Enter','Backspace'].includes(event.code)){event.preventDefault();send('up',event.code)}});draw();send('ready','READY');
</script></body></html>`;
const sourceHash=createHash('sha256').update(page).digest('hex');
const server=`import{createServer}from'node:http';const page=${JSON.stringify(page)};const events=[];const collector='http://172.17.0.1:28055';createServer(async(request,response)=>{const u=new URL(request.url,'http://localhost');if(u.pathname==='/event'&&request.method==='POST'){let body='';for await(const chunk of request)body+=chunk;try{const event=JSON.parse(body);events.push(event);await fetch(collector+'/event',{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(700)})}catch{}response.writeHead(204);response.end();return}if(u.pathname==='/events'){response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(events.filter(item=>item.mode===u.searchParams.get('mode'))));return}response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(page)}).listen(4173,'0.0.0.0');`;
const config={baseUrl:process.env.OPENSANDBOX_BASE_URL!,apiKey:process.env.OPENSANDBOX_API_KEY!,image:process.env.OPENSANDBOX_IMAGE!,lifetimeMs:300_000};
const workspace=new OpenSandboxWorkspace(config),controller=new AbortController();
const timer=setTimeout(()=>controller.abort('RC05_KEY_CANCEL_TIMEOUT'),240_000);
const started=Date.now();let handle:Awaited<ReturnType<typeof workspace.create>>|undefined;
let browser:RemoteBrowser|undefined,cleanupConfirmed=false,independentGet404=false;
let endpoint:Awaited<ReturnType<typeof workspace.endpoint>>|undefined;
const record:Record<string,unknown>={case:'E34 controlled Canvas seven keys and canceled batch',
  runtimeSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceHash,cancelOnly,fixtureBind:'0.0.0.0:4173'};
const joinEndpointPath=(base:string,relative:string)=>new URL(relative,base.endsWith('/')?base:base+'/');
// OpenSandbox proxy endpoints may be path-based (`domain/route/.../44772`).
// Assert that the child route retains the manager's proxy prefix.
if(joinEndpointPath('http://127.0.0.1:45320/route/sample/4173','events?mode=cancel').pathname
  !=='/route/sample/4173/events')throw Error('endpoint_path_join_regression');
const endpointPath=(relative:string)=>{
  if(!endpoint)throw Error('endpoint_missing');
  return joinEndpointPath(endpoint.url,relative);
};
const readEvents=async(mode:string)=>{
  if(!handle)throw Error('sandbox_missing');
  if(endpoint){
    try{
      const response=await fetch(endpointPath(`events?mode=${mode}`),{headers:endpoint.headers,signal:AbortSignal.timeout(2000)});
      if(response.ok)return await response.json() as Array<{mode:string;phase:string;key:string;at:number}>;
    }catch{ /* The manager tunnel remains a read-only fallback. */ }
  }
  if(cancelOnly)throw Error('endpoint_poll_failed');
  const response=await workspace.executeService(handle,`node -e 'fetch("http://127.0.0.1:4173/events?mode=${mode}").then(r=>r.text()).then(t=>console.log(t))'`,{uid:0,timeoutMs:3000});
  if(response.exitCode!==0)throw Error('event_log_read_failed');
  return JSON.parse(response.stdoutTail) as Array<{mode:string;phase:string;key:string;at:number}>;
};
try{
  const collectorHealth=await hostGet('/health');
  if(Array.isArray(collectorHealth)||collectorHealth.ready!==true)throw Error('host_collector_unavailable');
  record.collectorHost='172.17.0.1:28055';
  handle=await workspace.create({runId:randomUUID(),signal:controller.signal});
  record.sandboxId=handle.sandboxId;
  await workspace.writeServiceFile(handle,'rc05-key-cancel.mjs',server);
  await workspace.executeService(handle,'node /opt/pivloom/rc05-key-cancel.mjs',{uid:0,background:true});
  const version=await workspace.executeService(handle,'agent-browser --version',{uid:0,timeoutMs:5000});
  record.browserVersion=version.stdoutTail.trim();
  if(record.browserVersion!=='agent-browser 0.38.1')throw Error('agent_browser_version_mismatch');
  let ready=false;for(let i=0;i<16;i++){
    const result=await workspace.executeService(handle,"node -e 'fetch(\"http://127.0.0.1:4173/normal\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'",{uid:0,timeoutMs:3000});
    if(result.exitCode===0){ready=true;break}await new Promise(resolve=>setTimeout(resolve,300));
  }
  if(!ready)throw Error('fixture_server_unavailable');
  const collectorReach=await workspace.executeService(handle,
    "node -e 'fetch(\"http://172.17.0.1:28055/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))'",
    {uid:0,timeoutMs:3000});
  record.sandboxToHostCollector=collectorReach.exitCode===0;
  if(collectorReach.exitCode!==0)throw Error('sandbox_to_host_collector_unavailable');
  endpoint=await workspace.endpoint(handle,4173);
  record.endpointHost=new URL(endpoint.url).host;
  record.endpointBasePath=new URL(endpoint.url).pathname;
  let directAvailable=false;
  try{
    const response=await fetch(endpointPath('events?mode=cancel'),{headers:endpoint.headers,signal:AbortSignal.timeout(3000)});
    record.endpointStatus=response.status;
    directAvailable=response.ok&&Array.isArray(await response.json());
  }catch(error){record.endpointErrorName=error instanceof Error?error.name:'unknown';}
  record.endpointDirectAvailable=directAvailable;
  if(cancelOnly&&!directAvailable)throw Error('endpoint_unreachable');
  const browserSessionId='pivloom-'+randomUUID();record.browserSessionId=browserSessionId;
  browser=new RemoteBrowser(workspace,handle,undefined,browserSessionId);
  if(!cancelOnly){
  const initial=await browser.open('/normal');
  const before=await browser.screenshot();
  const backspaceIncluded=process.env.RC05_SKIP_BACKSPACE!=='1';
  const normalKeys=backspaceIncluded
    ?(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Space','Enter','Backspace'] as const)
    :(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Space','Enter'] as const);
  record.backspaceIncluded=backspaceIncluded;
  // The RemoteBrowser per-action ceiling is 15 s. Keep the two native batches
  // short; the second consumes the first batch's fresh observation ID.
  const direction=await browser.keyBatch({observationId:initial.id,steps:normalKeys.slice(0,5).map(key=>({key,waitMs:100}))});
  const edit=await browser.keyBatch({observationId:direction.observation.id,steps:normalKeys.slice(5).map(key=>({key,waitMs:100}))});
  const after=await browser.screenshot();
  const logs=await browser.logs();
  await writeFile(`${output}/normal-before.png`,Buffer.from(before.base64,'base64'));
  await writeFile(`${output}/normal-after.png`,Buffer.from(after.base64,'base64'));
  const pageEvents=await readEvents('normal');
  const consoleResult=await workspace.executeService(handle,`agent-browser --session ${browserSessionId} --json console`,{uid:0,timeoutMs:5000});
  let consoleData:unknown=null;try{consoleData=JSON.parse(consoleResult.stdoutTail)}catch{}
  record.normal={initialObservationId:initial.id,directionObservationId:direction.observation.id,finalObservationId:edit.observation.id,
    batches:[{startedAt:direction.startedAt,finishedAt:direction.finishedAt,steps:direction.steps},
      {startedAt:edit.startedAt,finishedAt:edit.finishedAt,steps:edit.steps}],
    beforeSha256:before.sha256,afterSha256:after.sha256,finalText:edit.observation.text,
    pageErrors:Array.isArray(logs.errors)?logs.errors:[],console:consoleData,
    eventLog:pageEvents};
  const down=pageEvents.filter(event=>event.phase==='down').map(event=>event.key);
  const up=pageEvents.filter(event=>event.phase==='up').map(event=>event.key);
  record.normalPass=direction.steps.length+edit.steps.length===normalKeys.length
    &&[...direction.steps,...edit.steps].every(step=>step.success)
    &&edit.observation.text.includes('TRAIL:START>'+normalKeys.join('>'))
    &&before.sha256!==after.sha256&&down.join('|')===normalKeys.join('|')&&up.join('|')===normalKeys.join('|')
    &&Array.isArray(logs.errors)&&logs.errors.length===0;
  process.stdout.write(JSON.stringify({phase:'normal',pass:record.normalPass,steps:direction.steps.length+edit.steps.length,
    enterAndBackspaceSeen:down.includes('Enter')&&down.includes('Backspace'),elapsedMs:Date.now()-started})+'\n');
  }

  const cancelInitial=await browser.open('/cancel');
  let readyEvents=await hostEvents();
  for(let i=0;i<8&&!readyEvents.some(event=>event.mode==='cancel'&&event.phase==='ready');i++){
    await new Promise(resolve=>setTimeout(resolve,100));readyEvents=await hostEvents();
  }
  record.browserToHostCollector=readyEvents.some(event=>event.mode==='cancel'&&event.phase==='ready');
  if(!record.browserToHostCollector)throw Error('browser_to_host_collector_unavailable');
  const longKeys=['ArrowUp','ArrowRight','ArrowDown','ArrowLeft'] as const;
  const firstKeyWait=hostGet('/wait-first-up').then(value=>({value}),error=>({error}));
  const longBatch=browser.keyBatch({observationId:cancelInitial.id,steps:longKeys.map(key=>({key,waitMs:1000}))})
    .then(()=>({completed:true as const,errorCode:null as string|null}),error=>({completed:false as const,
      errorCode:error instanceof Error?(error as {code?:string}).code??error.name:'unknown'}));
  const gate=await firstKeyWait;
  if('error' in gate)throw Error('host_first_key_wait_failed');
  const firstResult=gate.value;
  const firstSeen=!Array.isArray(firstResult)&&firstResult.observed===true;
  record.firstKeyGate=firstResult;
  if(!firstSeen)throw Error('cancel_first_input_not_seen');
  const cancelTriggeredAt=new Date().toISOString();
  const firstClose=await browser.close();
  const outcome=await longBatch;
  const batchOutcome=outcome.completed?'completed':'rejected',batchErrorCode=outcome.errorCode;
  const secondClose=await browser.close();
  await new Promise(resolve=>setTimeout(resolve,1300));
  const cancelEvents=await readEvents('cancel');
  const collectorEvents=(await hostEvents()).filter(event=>event.mode==='cancel');
  const localEvents=cancelEvents.map(event=>({mode:event.mode,phase:event.phase,key:event.key,at:event.at}));
  const forwardedEvents=collectorEvents.map(event=>({mode:event.mode,phase:event.phase,key:event.key,at:event.at}));
  const eventLogsMatch=JSON.stringify(localEvents)===JSON.stringify(forwardedEvents);
  const firstDown=collectorEvents.find(event=>event.phase==='down'&&event.key==='ArrowUp');
  const firstUp=collectorEvents.find(event=>event.phase==='up'&&event.key==='ArrowUp');
  record.cancel={initialObservationId:cancelInitial.id,cancelTriggeredAt,firstClose,secondClose,
    batchOutcome,batchErrorCode,eventLog:cancelEvents,collectorEvents,eventLogsMatch,
    firstKeyDownAt:firstDown?.at??null,firstKeyUpAt:firstUp?.at??null,
    firstKeyDownReceivedAt:firstDown?.receivedAt??null,firstKeyUpReceivedAt:firstUp?.receivedAt??null,
    downKeys:cancelEvents.filter(event=>event.phase==='down').map(event=>event.key),
    upKeys:cancelEvents.filter(event=>event.phase==='up').map(event=>event.key)};
  record.cancelPass=firstSeen&&batchOutcome==='rejected'&&secondClose.confirmed
    &&eventLogsMatch
    &&cancelEvents.filter(event=>event.phase==='down').map(event=>event.key).join('|')==='ArrowUp'
    &&cancelEvents.some(event=>event.phase==='up'&&event.key==='ArrowUp');
  process.stdout.write(JSON.stringify({phase:'cancel',pass:record.cancelPass,batchOutcome,batchErrorCode,
    downKeys:(record.cancel as {downKeys:string[]}).downKeys,secondCloseConfirmed:secondClose.confirmed,
    elapsedMs:Date.now()-started})+'\n');
}catch(error){record.errorCode=error instanceof Error?(error as {code?:string}).code??error.name:'unknown';
  record.errorMessage=error instanceof Error&&[
    'cancel_first_input_not_seen','event_log_read_failed','fixture_server_unavailable',
    'endpoint_unreachable','endpoint_poll_failed','host_collector_unavailable',
    'sandbox_to_host_collector_unavailable','browser_to_host_collector_unavailable',
    'host_first_key_wait_failed','host_event_log_invalid',
  ].includes(error.message)?error.message:null;
  if(handle)try{record.cancelEventsAtError=await readEvents('cancel');}catch{}
  process.stdout.write(JSON.stringify({phase:'error',errorCode:record.errorCode,elapsedMs:Date.now()-started})+'\n');
  if(browser)try{await browser.close();}catch{}
}finally{
  clearTimeout(timer);
  if(handle){cleanupConfirmed=(await workspace.destroy(handle)).confirmed;
    try{const independent=await Sandbox.connect({connectionConfig:sandboxConnectionConfig(config),sandboxId:handle.sandboxId,readyTimeoutSeconds:5});await independent.getInfo();await independent.close();}
    catch(error){independentGet404=error instanceof SandboxApiException&&error.statusCode===404;}}
  record.cleanupConfirmed=cleanupConfirmed;record.independentGet404=independentGet404;record.elapsedMs=Date.now()-started;
  record.modulePass=record.backspaceIncluded===true&&record.normalPass===true&&record.cancelPass===true
    &&cleanupConfirmed&&independentGet404;
  await writeFile(`${output}/result.json`,JSON.stringify(record,null,2)+'\n');
  process.stdout.write(JSON.stringify({phase:'done',modulePass:record.modulePass,cleanupConfirmed,independentGet404,elapsedMs:record.elapsedMs})+'\n');
}
