import { expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { RemoteBrowser } from '../../src/runtime/browser.js';
import { OpenSandboxWorkspace, type SandboxConnection } from '../../src/runtime/workspace.js';

async function fixture(signal?: AbortSignal) {
  let malformed=false,fileProtocol=false,closeCalls=0,live=true,hangResultRead=false;
  let resultReadStarted:()=>void=()=>{};
  const resultRead=new Promise<void>(resolve=>{resultReadStarted=resolve;});
  const files=new Map<string,Uint8Array>();
  let result: unknown = { observation: { id: '22222222-2222-4222-8222-222222222222', sessionId: 'pivloom-11111111-1111-4111-8111-111111111111', url: 'http://127.0.0.1:4173/', tree: '- status "Result"', text: '0\nHistory\n1+2 = 3', truncated: false, refs: {} }, matches: [{ text: '0', value: null }] };
  const connection: SandboxConnection = {
    sandboxId: 'program-fixture', kill: async () => {live=false;}, isRunning: async () => live, renew: async () => {}, close: async () => {},
    endpoint: async () => ({ url: 'http://127.0.0.1:4173', headers: {} }), write: async () => {}, read: async path => {
      if(hangResultRead&&path.startsWith('/opt/pivloom/browser-result-')){resultReadStarted();return new Promise<Uint8Array>(()=>{});}
      return files.get(path) ?? new Uint8Array();
    },
    run: async command => {
      let stdoutTail=JSON.stringify({success:true,data:result});
      if(command.endsWith("'close'")){closeCalls++;stdoutTail=JSON.stringify({success:true,data:{closed:true}});}
      else if(command.startsWith('node /opt/pivloom/browser-program.mjs')){
        if(malformed)stdoutTail='{';
        else if(fileProtocol){const name=/"resultFile":"([^"]+)"/.exec(command)![1];files.set('/opt/pivloom/'+name,Buffer.from(stdoutTail));stdoutTail=JSON.stringify({resultFile:name});}
      }
      return {id:'command',interrupt:async()=>{},wait:async()=>({exitCode:0,stdoutTail,stderrTail:''})};
    },
  };
  const workspace = new OpenSandboxWorkspace({baseUrl:'http://localhost:18080',apiKey:'fixture',image:'fixture'},{create:async()=>connection});
  const handle = await workspace.create({runId:'program-test',signal:new AbortController().signal});
  const browser = new RemoteBrowser(workspace,handle,undefined,'pivloom-11111111-1111-4111-8111-111111111111',signal);
  return {browser,setResult(value:unknown){result=value;},cleanup:()=>workspace.destroy(handle),malformed:()=>{malformed=true;},useFiles:()=>{fileProtocol=true;},hangRead:()=>{hangResultRead=true;},resultRead,files,closeCalls:()=>closeCalls};
}

test('scoped inspection returns the result separately from retained history',async()=>{
 const f=await fixture();try{const value=await f.browser.inspect({role:'status',name:'Result'});expect(value.matches).toEqual([{text:'0',value:null}]);expect(value.observation.text).toContain('1+2 = 3');}finally{await f.cleanup();}
});
test('sandbox inspection cannot return evidence from another origin',async()=>{
 const f=await fixture();try{f.setResult({observation:{id:'22222222-2222-4222-8222-222222222222',sessionId:f.browser.sessionId,url:'https://foreign.invalid/',tree:'',text:'',truncated:false,refs:{}},matches:[]});await expect(f.browser.inspect({role:'status',name:'Result'})).rejects.toMatchObject({code:'BROWSER_ORIGIN_REJECTED'});}finally{await f.cleanup();}
});
test('a cancelled verification cannot start a fresh browser program',async()=>{
 const controller=new AbortController();controller.abort('CANCELLED');const f=await fixture(controller.signal);try{await expect(f.browser.reset('/')).rejects.toBe('CANCELLED');}finally{await f.cleanup();}
});


test('a native command that opens Chromium but returns malformed JSON must still close it',async()=>{
 const f=await fixture();try{f.malformed();await expect(f.browser.inspect({role:'status',name:'Result'})).rejects.toMatchObject({code:'BROWSER_BLOCKED'});expect(await f.browser.close()).toEqual({confirmed:true});expect(f.closeCalls()).toBe(1);}finally{await f.cleanup();}
});
test('native observation packets larger than the shell tail survive via the result file',async()=>{
 const f=await fixture();try{
  f.useFiles();const frames=Array.from({length:40},(_,index)=>({index,kind:'observation',observation:{id:randomUUID(),sessionId:f.browser.sessionId,url:'http://127.0.0.1:4173/',tree:'x'.repeat(32000),text:'y'.repeat(32000),truncated:false,refs:{}}}));
  f.setResult({frames,logs:{errors:[]},commandCount:40});expect(JSON.stringify(frames).length).toBeGreaterThan(2000000);
  const result=await f.browser.executeProgram({steps:frames.map(()=>({type:'open',path:'/'}))});expect(result.frames).toHaveLength(40);expect(result.frames[0].observation?.text).toHaveLength(32000);
 }finally{await f.cleanup();}
});
test('large permitted screenshots transfer as binary artifacts rather than shell base64',async()=>{
 const f=await fixture();try{
  f.useFiles();const png=Buffer.alloc(1600000);png.set([137,80,78,71,13,10,26,10]);const name=randomUUID()+'.png';const sha256=createHash('sha256').update(png).digest('hex');
  f.files.set('/tmp/pivloom-browser/'+name,png);f.setResult({frames:[{index:0,kind:'screenshot',image:{fileName:name,bytes:png.length,mimeType:'image/png',sha256}}],logs:{errors:[]},commandCount:1});
  const result=await f.browser.executeProgram({steps:[{type:'capture'}]});expect(Buffer.from(result.frames[0].image!.base64,'base64')).toEqual(png);
 }finally{await f.cleanup();}
});
test('cancellation interrupts a stalled result download and still closes Chromium',async()=>{
 const controller=new AbortController();const f=await fixture(controller.signal);try{
  f.useFiles();f.hangRead();const operation=f.browser.inspect({role:'status',name:'Result'});
  const stopped=expect(operation).rejects.toBe('CANCELLED');await f.resultRead;controller.abort('CANCELLED');await stopped;
  expect(await f.browser.close()).toEqual({confirmed:true});expect(f.closeCalls()).toBe(1);
 }finally{await f.cleanup();}
});
