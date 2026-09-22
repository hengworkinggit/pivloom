import {Sandbox,ConnectionConfig} from '@alibaba-group/opensandbox';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),dir='/opt/pivloom/g0-sandbox';
const key=(await fs.readFile(dir+'/control-key','utf8')).trim();
const connectionConfig=new ConnectionConfig({domain:'127.0.0.1:18080',protocol:'http',apiKey:key,requestTimeoutSeconds:30});
const base={connectionConfig,image:'pivloom-g0:20260922',resource:{cpu:'1',memory:'256Mi'},metadata:{'pivloom-test':'g0-20260922'},readyTimeoutSeconds:30};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const checks=[];
async function save(x){checks.push({at:new Date().toISOString(),...x});await fs.writeFile(dir+'/lifecycle.json',JSON.stringify(checks,null,2));console.log(JSON.stringify(x))}
async function exists(id){const {stdout}=await exec('docker',['ps','-aq','--filter',`name=sandbox-${id}`]);return !!stdout.trim()}
let small;
try {
 const c=new AbortController();let cancelledId;
 try {
  await Sandbox.create({...base,timeoutSeconds:120,signal:c.signal,healthCheck:async sb=>{cancelledId=sb.id;c.abort();return false}});
  throw new Error('Creation unexpectedly resolved after abort');
 } catch(e) {
  if(!cancelledId)throw new Error('Create failed before allocation: '+String(e));
  for(let i=0;i<25&&await exists(cancelledId);i++)await sleep(400);
  assert.equal(await exists(cancelledId),false);
  await save({name:'cancel-during-create',sandboxId:cancelledId,removed:true});
 }
 small=await Sandbox.create({...base,timeoutSeconds:60});const ttlId=small.id;const started=Date.now();
 await small.files.writeFiles([{path:'/workspace/isolation-marker.txt',data:'short-lived isolated file'}]);
 const primaryId=JSON.parse(await fs.readFile(dir+'/active-gvisor.json','utf8')).id;
 const primary=await Sandbox.connect({connectionConfig,sandboxId:primaryId});
 try {
  const isolation=await primary.commands.run('test ! -e /workspace/isolation-marker.txt && echo isolated',{timeoutSeconds:10});
  assert.equal(isolation.exitCode,0);await save({name:'two-sandbox-file-isolation',passed:true,primaryId,ttlId});
 }finally{await primary.close()}
 for(let i=0;i<90&&await exists(ttlId);i++)await sleep(1000);
 assert.equal(await exists(ttlId),false,'TTL container remained after its expiry grace');
 await save({name:'ttl-expiry',sandboxId:ttlId,removed:true,elapsedMs:Date.now()-started,configuredSeconds:60});
 await small.close();small=undefined;
} catch(e){await save({name:'failure',error:String(e).replaceAll(key,'[REDACTED]')});process.exitCode=1}
finally{if(small){try{await small.kill()}catch{}try{await small.close()}catch{}}}
