// Throwaway infrastructure probe. The React app is an explicit test fixture.
import { Sandbox, ConnectionConfig } from '@alibaba-group/opensandbox';
import fs from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir='/opt/pivloom/g0-sandbox';
const variant=process.argv[2] || 'runc';
const key=(await fs.readFile(`${dir}/control-key`,'utf8')).trim();
const config=new ConnectionConfig({domain:'127.0.0.1:18080',protocol:'http',apiKey:key,requestTimeoutSeconds:60});
const report={variant,fixture:true,startedAt:new Date().toISOString(),checks:[],status:'RUNNING'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function record(name,details={}) {
  report.checks.push({name,at:new Date().toISOString(),...details});
  await fs.writeFile(`${dir}/report-${variant}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({name,...details}));
}
let sandbox,previewProxy,frameServer;
async function command(cmd,opts={}) {
  const r=await sandbox.commands.run(cmd,{workingDirectory:'/workspace',timeoutSeconds:60,...opts});
  const out=r.logs.stdout.map(x=>x.text).join('\n');
  const err=r.logs.stderr.map(x=>x.text).join('\n');
  if(r.error || (r.exitCode!=null && r.exitCode!==0))throw new Error(JSON.stringify({command:cmd,error:r.error,exitCode:r.exitCode,stderr:err.slice(-2500)}));
  return {out,err,id:r.id,exitCode:r.exitCode};
}
try {
  const started=Date.now();
  sandbox=await Sandbox.create({connectionConfig:config,image:'pivloom-g0:20260922',resource:{cpu:'1',memory:'1Gi'},timeoutSeconds:1200,readyTimeoutSeconds:90,metadata:{'pivloom-test':'g0-20260922',variant}});
  report.sandboxId=sandbox.id;
  await fs.writeFile(`${dir}/active-${variant}.json`,JSON.stringify({id:sandbox.id}));
  await record('create',{id:sandbox.id,durationMs:Date.now()-started});
  await sandbox.files.writeFiles([{path:'/workspace/roundtrip.txt',data:'probe before\n',mode:644}]);
  assert.equal(await sandbox.files.readFile('/workspace/roundtrip.txt'),'probe before\n');
  await sandbox.files.writeFiles([{path:'/workspace/roundtrip.txt',data:'probe after\n',mode:644}]);
  assert.equal(await sandbox.files.readFile('/workspace/roundtrip.txt'),'probe after\n');
  await record('file-roundtrip-edit',{passed:true});
  const versions=await command('node --version && chromium --version && agent-browser --version');
  await record('versions',{output:versions.out});
  const hostBoundary=await command('test ! -e /opt/pivloom/g0-sandbox/control-key && test ! -S /var/run/docker.sock && echo host-resources-unmounted');
  await record('host-file-boundary',{output:hostBoundary.out});
  const pkg=JSON.parse(await sandbox.files.readFile('/workspace/package.json'));
  pkg.type='module';pkg.scripts={build:'tsc --noEmit && vite build',preview:'vite preview --host 0.0.0.0 --port 4173 --strictPort'};
  const app=`import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
type Task={name:string,done:boolean};
function App(){
const [tasks,setTasks]=useState<Task[]>(()=>JSON.parse(localStorage.getItem('g0-tasks')||'[]'));
const [name,setName]=useState('');const [filter,setFilter]=useState('all');
useEffect(()=>localStorage.setItem('g0-tasks',JSON.stringify(tasks)),[tasks]);
return <main><p>G0 · Sandbox compatibility fixture</p><h1>沙箱任务板</h1>
<form onSubmit={e=>{e.preventDefault();if(name.trim()){setTasks([...tasks,{name:name.trim(),done:false}]);setName('')}}}>
<label>任务名称<input value={name} onChange={e=>setName(e.target.value)} required /></label><button>添加任务</button></form>
<label>状态筛选<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部</option><option value="done">已完成</option></select></label>
<p>任务总数：{tasks.length}；已完成：{tasks.filter(t=>t.done).length}</p><ul>{tasks.map((t,i)=>filter==='done'&&!t.done?null:<li key={i}><label><input type="checkbox" checked={t.done} onChange={()=>setTasks(tasks.map((x,j)=>j===i?{...x,done:!x.done}:x))}/>{t.name}</label></li>)}</ul>
<small>这是固定测试应用，用来验证构建、浏览器操作和预览；不是模型生成成果。</small></main>}
createRoot(document.getElementById('root')!).render(<App/>);`;
  const files={
    'package.json':JSON.stringify(pkg,null,2),
    'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',lib:['ES2022','DOM'],module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,skipLibCheck:true,noEmit:true,esModuleInterop:true},include:['src.tsx']}),
    'src.tsx':app,
    'index.html':'<!doctype html><html lang="zh"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>G0 sandbox fixture</title><style>body{font:16px system-ui;background:#f4f5f7;color:#17202a;margin:0}main{max-width:680px;margin:36px auto;padding:28px;background:white;border-radius:16px}label{display:block;margin:14px 0}input,select,button{font:inherit;padding:10px;margin:4px;border:1px solid #b7c0cc;border-radius:8px}button{background:#1649cc;color:white}li{list-style:none}ul{padding:0}small{color:#64748b}@media(max-width:420px){main{margin:0;padding:18px}input{max-width:230px}}</style><div id="root"></div><script type="module" src="/src.tsx"></script></html>',
    'public/g0-marker.json':JSON.stringify({kind:'infrastructure-fixture',variant,sandboxId:sandbox.id})
  };
  await sandbox.files.createDirectories([{path:'/workspace/public',mode:755}]);
  await sandbox.files.writeFiles(Object.entries(files).map(([path,data])=>({path:'/workspace/'+path,data,mode:644})));
  const buildStart=Date.now();
  const built=await command('npm run build',{timeoutSeconds:120});
  await record('typescript-react-vite-build',{durationMs:Date.now()-buildStart,output:built.out});
  const bad=await sandbox.commands.run('exit 7',{workingDirectory:'/workspace',timeoutSeconds:10});
  assert.ok(bad.error || bad.exitCode===7,'failed command must be reported');
  await record('nonzero-command',{exitCode:bad.exitCode,error:bad.error});
  const preview=await sandbox.commands.run('npm run preview',{background:true,workingDirectory:'/workspace'});
  await record('preview-process',{commandId:preview.id});
  await sleep(1200);
  const ep=await sandbox.getEndpoint(4173);
  const base=`http://${ep.endpoint}`;
  const endpointHeaders=ep.headers||{};
  const raw=await fetch(`${base}/g0-marker.json`,{headers:endpointHeaders});
  assert.equal(raw.status,200);assert.equal((await raw.json()).sandboxId,sandbox.id);
  await record('preview-endpoint',{endpoint:ep.endpoint,headersRequired:Object.keys(endpointHeaders).length>0});
  previewProxy=http.createServer(async(req,res)=>{
    try {
      const target=base+(req.url||'/');
      const upstream=await fetch(target,{headers:endpointHeaders,redirect:'manual'});
      res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/octet-stream','Cache-Control':'no-store'});
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }catch{res.writeHead(502);res.end('Preview unavailable');}
  });
  await new Promise(resolve=>previewProxy.listen(18473,'127.0.0.1',resolve));
  frameServer=http.createServer((req,res)=>{
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><title>G0 infrastructure verification</title><meta name="viewport" content="width=device-width,initial-scale=1"><h1>远程沙箱 · G0 实测</h1><p>固定测试应用；前端 45242 与预览 45241 为不同 origin。</p><iframe title="Sandbox fixture" sandbox="allow-scripts allow-forms allow-same-origin" src="http://localhost:45243/" style="width:100%;height:700px;border:1px solid #ddd"></iframe>');
  });
  await new Promise(resolve=>frameServer.listen(18474,'127.0.0.1',resolve));
  await record('browser-ready',{previewUrl:'http://localhost:45243/',iframeUrl:'http://localhost:45244/'});
  await command('agent-browser --session g0 open http://127.0.0.1:4173');
  const snapshot=await command('agent-browser --session g0 snapshot -i');
  await record('chrome-snapshot',{output:snapshot.out});
  await fs.writeFile(`${dir}/ready-${variant}`,sandbox.id);
  // Interactive browser verification is performed separately; it releases this hold.
  const deadline=Date.now()+15*60*1000;
  while(Date.now()<deadline){try{await fs.access(`${dir}/finish-${variant}`);break}catch{}await sleep(1000)}
  const long=await sandbox.commands.run("bash -c 'sleep 300 & echo $! >/workspace/child.pid; wait'",{background:true,workingDirectory:'/workspace'});
  assert.ok(long.id);await sleep(500);
  await sandbox.commands.interrupt(long.id);
  await sleep(500);
  const status=await sandbox.commands.getCommandStatus(long.id);
  const child=await command("if kill -0 $(cat /workspace/child.pid) 2>/dev/null; then echo alive; else echo stopped; fi");
  await record('command-interrupt',{commandStatus:status,childStatus:child.out.trim()});
  await command('agent-browser --session g0 close');
  await sandbox.kill();
  let removed=false;try{await sandbox.getInfo()}catch{removed=true}
  assert.ok(removed);
  await record('sandbox-kill',{removed});
  report.status='INFRA_PROBE_COMPLETE';
}catch(e){report.status='FAILED';await record('failure',{message:String(e).replaceAll(key,'[REDACTED]')});process.exitCode=1;}
finally{
  if(sandbox){try{await sandbox.kill()}catch{}try{await sandbox.close()}catch{}}
  previewProxy?.closeAllConnections();previewProxy?.close();frameServer?.closeAllConnections();frameServer?.close();
  report.finishedAt=new Date().toISOString();await fs.writeFile(`${dir}/report-${variant}.json`,JSON.stringify(report,null,2));
}
