/** Trusted sandbox-side browser operations. Only data crosses this interface; no model script is evaluated. */
export const browserProgramSource = String.raw`
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
const execute = promisify(execFile);
const input = JSON.parse(process.argv[2]);
const origin = 'http://127.0.0.1:4173';
const deadline = Date.now() + Math.max(1, Math.min(input.timeoutMs, 120000));
let commandCount = 0;
let socket;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) fail('BROWSER_TIMEOUT', '浏览器程序超过执行预算'); return ms; };
if (!/^pivloom-[0-9a-f-]{36}$/.test(input.session)) fail('INVALID_BROWSER_SESSION', '无效浏览器会话');
async function cli(args, stdin) {
  remaining(); commandCount++;
  let output;
  try {
    if (stdin === undefined) output = await execute('agent-browser', ['--session', input.session, '--json', ...args], { timeout: Math.min(remaining(), 15000), maxBuffer: 2000000 });
    else output = await new Promise((resolve, reject) => {
      const child = execFile('agent-browser', ['--session', input.session, '--json', ...args], { timeout: Math.min(remaining(), 15000), maxBuffer: 2000000 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin.end(stdin);
    });
  } catch (error) {
    if (error.killed) fail('BROWSER_TIMEOUT', '浏览器命令超过执行预算');
    fail('BROWSER_BLOCKED', '浏览器命令未完成');
  }
  let parsed;
  try { parsed = JSON.parse(output.stdout); } catch { fail('BROWSER_BLOCKED', '浏览器响应格式错误'); }
  if (Array.isArray(parsed)) return parsed;
  if (parsed.success !== true) fail('BROWSER_BLOCKED', typeof parsed.error === 'string' ? parsed.error.slice(0, 300) : '浏览器动作失败');
  return parsed.data ?? {};
}
async function checkOrigin() {
  const data = await cli(['get', 'url']);
  let url; try { url = new URL(data.url); } catch { fail('BROWSER_ORIGIN_REJECTED', '无效页面来源'); }
  if (url.origin !== origin || url.username || url.password) fail('BROWSER_ORIGIN_REJECTED', '浏览器离开候选预览来源');
  return url.href;
}
async function observe() {
  const before = await checkOrigin();
  const snapshot = await cli(['snapshot', '-i']);
  const body = await cli(['get', 'text', 'body']);
  const url = await checkOrigin();
  if (before !== url) fail('BROWSER_OBSERVATION_CHANGED', '观察期间页面发生导航');
  if (typeof snapshot.snapshot !== 'string' || typeof body.text !== 'string') fail('BROWSER_BLOCKED', '页面观察不完整');
  return { id: randomUUID(), sessionId: input.session, url, tree: snapshot.snapshot.slice(0,32000), text: body.text.slice(0,32000),
    truncated: snapshot.snapshot.length > 32000 || body.text.length > 32000, refs: snapshot.refs ?? {} };
}
function pathUrl(path = '/') {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) fail('BROWSER_ORIGIN_REJECTED', '浏览器只能访问本候选预览');
  return origin + path;
}
async function open(path, fresh = false) {
  if (fresh) { await cli(['close']); if (socket) { socket.close(); socket = undefined; } }
  await cli(['open', pathUrl(path)]);
  return observe();
}
async function capture() {
  await checkOrigin(); await mkdir('/tmp/pivloom-browser', {recursive:true});
  const path = '/tmp/pivloom-browser/' + randomUUID() + '.png';
  await cli(['screenshot', path]); const bytes = await readFile(path); await checkOrigin();
  if (bytes.length > 2 * 1024 * 1024 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('INVALID_SCREENSHOT', '截图格式或大小错误');
  return {base64:bytes.toString('base64'), mimeType:'image/png', sha256:createHash('sha256').update(bytes).digest('hex')};
}
let cdp;
async function connectCdp() {
  if (cdp && socket?.readyState === 1) return cdp;
  const endpoint = await cli(['get', 'cdp-url']);
  const wsUrl = endpoint.cdpUrl ?? endpoint.url;
  if (typeof wsUrl !== 'string') fail('BROWSER_BLOCKED', '浏览器没有提供本地检查端点');
  const parsed = new URL(wsUrl);
  if (!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || parsed.protocol !== 'ws:') fail('BROWSER_ORIGIN_REJECTED', '检查端点不是沙箱本机');
  socket = new WebSocket(wsUrl);
  await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error('CDP connect timeout')), Math.min(remaining(),5000)); socket.onopen=()=>{clearTimeout(timer);resolve();};socket.onerror=()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));}; });
  let sequence=0; const pending=new Map();
  socket.onmessage=({data})=>{ const message=JSON.parse(data); const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);clearTimeout(waiter.timer);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result); };
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP request timeout'));},Math.min(remaining(),5000));pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const targets=await send('Target.getTargets');
  const pages=targets.targetInfos.filter(t=>t.type==='page' && t.url.startsWith(origin+'/'));
  if(pages.length!==1) fail('BROWSER_BLOCKED','无法唯一确定候选页面');
  const attached=await send('Target.attachToTarget',{targetId:pages[0].targetId,flatten:true});
  cdp=(method,params={})=>send(method,params,attached.sessionId);return cdp;
}
async function inspect(target) {
  await checkOrigin(); const send=await connectCdp();
  const {nodes}=await send('Accessibility.getFullAXTree'); const byId=new Map(nodes.map(n=>[n.nodeId,n]));
  const matches=(n,t)=>!n.ignored && n.role?.value?.toLowerCase()===t.role.toLowerCase() && (t.name===undefined || n.name?.value===t.name);
  let scope;
  if(target.within){const scopes=nodes.filter(n=>matches(n,target.within));if(scopes.length!==1)fail('TEST_TARGET_AMBIGUOUS','检查范围无法唯一定位');scope=scopes[0].nodeId;}
  const inside=n=>{if(!scope)return true;let parent=n.parentId;while(parent){if(parent===scope)return true;parent=byId.get(parent)?.parentId;}return false;};
  const selected=nodes.filter(n=>matches(n,target)&&inside(n)&&n.backendDOMNodeId);
  if(selected.length>256) fail('TEST_TARGET_AMBIGUOUS','检查对象超过可观察数量');
  const values=[];
  for(const node of selected){
    const {object}=await send('DOM.resolveNode',{backendNodeId:node.backendDOMNodeId});
    const result=await send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){return {text:this.innerText ?? this.textContent ?? "",value:("value" in this && typeof this.value === "string")?this.value:null}}',returnByValue:true});
    await send('Runtime.releaseObject',{objectId:object.objectId});
    if(result.exceptionDetails || !result.result?.value) fail('BROWSER_BLOCKED','无法读取目标控件');
    const value=result.result.value;if(value.text.length>32000)fail('TEST_TARGET_AMBIGUOUS','目标文本超过观察上限');values.push(value);
  }
  return {matches:values,observation:await observe()};
}
async function logs(){await checkOrigin();const result=await cli(['errors']);await checkOrigin();return result;}
async function act(action){
  await checkOrigin();
  const args=action.type==='click'?['click','@'+action.ref]:action.type==='fill'?['fill','@'+action.ref,action.text]:action.type==='select'?['select','@'+action.ref,action.value]:action.type==='scroll'?['scroll',action.direction,'600']:['press',action.key];
  await cli(args);return observe();
}
async function keys(steps){
  await checkOrigin();const commands=[];
  for(const step of steps){commands.push(['press',step.key]);if(step.waitMs)commands.push(['wait',String(step.waitMs)]);}
  const startedAt=new Date().toISOString();const results=await cli(['batch','--bail'],JSON.stringify(commands));
  if(!Array.isArray(results)||results.length!==commands.length||results.some(r=>r.success!==true))fail('BROWSER_BLOCKED','按键批次没有完整执行');
  return {observation:await observe(),startedAt,finishedAt:new Date().toISOString(),steps:steps.map((s,index)=>({index,...s,success:true}))};
}
async function resize(width,height){
  await checkOrigin();await cli(['set','viewport',String(width),String(height)]);
  const measured=await cli(['eval','({width:innerWidth,height:innerHeight,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth??0)})']);
  const m=measured.result;if(m?.width!==width||m?.height!==height)fail('BROWSER_BLOCKED','浏览器未确认视口');
  const observation=await observe();observation.text='[viewport] width='+m.width+' height='+m.height+' scrollWidth='+m.scrollWidth+'\n'+observation.text;return observation;
}
async function program(payload){
  const frames=[];let latest=payload.observation;const steps=payload.steps;
  for(let index=payload.startIndex??0;index<steps.length;index++){
    const step=steps[index];remaining();
    try{
      if(step.type==='capture'){if(!latest)fail('STALE_BROWSER_REF','截图前没有页面观察');frames.push({index,kind:'screenshot',image:await capture()});continue;}
      if(step.type==='open') latest=await open(step.path, index===0 && payload.initialState==='fresh');
      else if(!latest)fail('STALE_BROWSER_REF','操作前没有页面观察');
      else if(step.type==='reload'){const url=new URL(latest.url);latest=await open(url.pathname+url.search+url.hash);}
      else if(step.type==='resize')latest=await resize(step.width,step.height);
      else if(step.type==='wait'){await new Promise(r=>setTimeout(r,Math.min(step.ms,remaining())));latest=await observe();}
      else if(step.type==='key_sequence'){
        const expanded=Array.from({length:step.repeat??1},()=>step.keys).flat();if(expanded.length>512)fail('INVALID_BROWSER_ACTION','按键序列过大');
        const batch=await keys(expanded.map(key=>({key,waitMs:0})));latest=batch.observation;
      }else if(step.type==='press')latest=await act({type:'press',key:step.key});
      else{
        const candidates=Object.entries(latest.refs).filter(([,r])=>r.role===step.role&&r.name===step.name);
        const override=payload.resolvedRefs?.[index];
        if(candidates.length!==1 && !(override&&Object.hasOwn(latest.refs,override)))return {frames,pending:{index,observation:latest,step},commandCount};
        latest=await act({...step,ref:override??candidates[0][0]});
      }
      frames.push({index,kind:'observation',observation:latest});
    }catch(error){return {frames,error:{index,code:error.code??'BROWSER_BLOCKED',message:error.message},commandCount};}
  }
  const inspections=[];
  for(const target of payload.targets??[]){try{inspections.push({target,...await inspect(target)});}catch(error){return {frames,error:{index:steps.length,code:error.code??'BROWSER_BLOCKED',message:error.message},commandCount};}}
  return {frames,inspections,logs:await logs(),commandCount};
}
try {
  const op=input.operation;
  const result=op.kind==='program'?await program(op):op.kind==='inspect'?await inspect(op.target):op.kind==='reset'?await open(op.path,true):op.kind==='open'?await open(op.path):op.kind==='observe'?await observe():op.kind==='act'?await act(op.action):op.kind==='keys'?await keys(op.steps):op.kind==='resize'?await resize(op.width,op.height):op.kind==='screenshot'?await capture():op.kind==='logs'?await logs():null;
  if(result===null)fail('INVALID_BROWSER_ACTION','不支持的浏览器操作');
  process.stdout.write(JSON.stringify({success:true,data:result,commandCount}));
}catch(error){process.stdout.write(JSON.stringify({success:false,error:{code:error.code??'BROWSER_BLOCKED',message:String(error.message).slice(0,500)},commandCount}));process.exitCode=1;}
finally{socket?.close();}
`;
