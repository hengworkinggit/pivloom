import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const execute=promisify(execFile);
const script=process.argv[2];const fixture=process.argv[3];
if(!script||!fixture)throw Error('Pass sandbox helper and calculator HTML fixture paths');
const html=await readFile(fixture);const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
await new Promise(r=>server.listen(4173,'127.0.0.1',r));
const session='pivloom-00000000-0000-4000-8000-000000000001';
const target={role:'status',name:'Result'};const count={role:'listitem',within:{role:'list',name:'History'}};
const run=async(operation)=>{
 const start=performance.now();const output=await execute('node',[script,JSON.stringify({session,timeoutMs:120000,operation})],{timeout:125000,maxBuffer:4000000});
 const result=JSON.parse(output.stdout);assert.equal(result.success,true,JSON.stringify(result.error));return {...result.data,elapsedMs:Math.round(performance.now()-start)};
};
try{
 const keys=[];for(let n=1;n<=21;n++)keys.push('Escape',...String(n),'+',...String(n),'Enter');
 const first=await run({kind:'program',initialState:'fresh',steps:[{type:'open',path:'/'},{type:'key_sequence',keys},{type:'capture'}],targets:[target,count]});
 assert.equal(first.error,undefined);assert.equal(first.inspections[0].matches[0].text,'42');assert.equal(first.inspections[1].matches.length,20);
 assert.equal(first.inspections[1].matches[0].text,'2+2 = 4');assert.equal(first.inspections[1].matches[19].text,'21+21 = 42');
 console.log(JSON.stringify({case:'21 real calculations, scoped result and 20-row retention',status:'PASS',elapsedMs:first.elapsedMs,commands:first.commandCount,steps:keys.length}));
 const next=await run({kind:'program',initialState:'continue',steps:[{type:'open',path:'/'},{type:'press',key:'Escape'}],targets:[target,count]});
 assert.equal(next.inspections[0].matches[0].text,'0');assert.equal(next.inspections[1].matches.length,20);
 console.log(JSON.stringify({case:'reload preserves history while scoped clear result is zero',status:'PASS',elapsedMs:next.elapsedMs,commands:next.commandCount}));
 const fresh=await run({kind:'program',initialState:'fresh',steps:[{type:'open',path:'/'}],targets:[target,count]});
 assert.equal(fresh.inspections[1].matches.length,0);assert.notEqual(fresh.inspections[0].matches[0].text,'2');
 console.log(JSON.stringify({case:'fresh scenario isolated; keypad text cannot satisfy result',status:'PASS',elapsedMs:fresh.elapsedMs,commands:fresh.commandCount}));
}finally{await execute('agent-browser',['--session',session,'close']).catch(()=>{});server.close();}
