import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { runReplayProgram, type ReplayProgram, type ReplayBrowser } from '../../src/runtime/replay.js';
import type { BrowserProgramResponse, BrowserObservation } from '../../src/runtime/browser.js';
import { formFixture, PNG_BASE64, PNG_SHA256 } from './replay-fixture.js';

function fixture(value='42') {
 const base=formFixture('pivloom-'+randomUUID());
 const observation:BrowserObservation={id:randomUUID(),sessionId:base.browser.sessionId,url:'http://127.0.0.1:4173/',tree:'status Result',text:'999 keypad 2 history 1+1 = 2',truncated:false,refs:{}};
 const target={role:'status',name:'Result'};
 const program:ReplayProgram={behaviorId:'B01',initialState:'fresh',steps:[{type:'open',path:'/'},{type:'key_sequence',keys:['6','*','7','Enter'],repeat:1},{type:'capture'}],assertions:[{kind:'target-text',target,text:'42',match:'exact',negated:false}]};
 let calls=0;
 const response:BrowserProgramResponse={frames:[{index:0,kind:'observation',observation},{index:1,kind:'observation',observation:{...observation,id:randomUUID()},batch:{startedAt:'2026-09-27T00:00:00.000Z',finishedAt:'2026-09-27T00:00:00.010Z',steps:['6','*','7','Enter'].map((key,index)=>({key:key as '6'|'*'|'7'|'Enter',index,waitMs:0,success:true}))}},{index:2,kind:'screenshot',image:{base64:PNG_BASE64,mimeType:'image/png',sha256:PNG_SHA256}}],inspections:[{target,observation:{...observation,id:randomUUID()},matches:[{text:value,value:null}]}],logs:{errors:[]},commandCount:10};
 const browser:ReplayBrowser={...base.browser,nativePrograms:true,reset:()=>base.browser.open(),keyBatch:async()=>{throw Error('must execute near browser')},executeProgram:async()=>{calls++;return response}};
 const run=()=>runReplayProgram({browser,program,signal:new AbortController().signal,target:{expected:'Result is exactly 42'},rendersOnly:false,saveScreenshot:async image=>({id:randomUUID(),key:'fixture/check.png',bytes:Buffer.from(image.base64,'base64').length,sha256:image.sha256,mimeType:'image/png'})});
 return {run,response,base,calls:()=>calls};
}

test('native execution runs the sealed sequence once and preserves scoped outcomes and actual keys',async()=>{
 const f=fixture();const result=await f.run();expect(result.item.verdict).toBe('passed');expect(f.calls()).toBe(1);expect(f.base.calls.act).toBe(0);expect(result.events.find(event=>event.batch)?.batch?.steps).toHaveLength(4);expect(result.item.observationEventIds).toContain(result.observations.at(-1)?.id);
});
test('native execution does not let keypad or historical text satisfy a wrong scoped result',async()=>{
 const f=fixture('999');expect((await f.run()).item.verdict).toBe('failed');
});
test('a native runner missing one input frame cannot certify the application',async()=>{
 const f=fixture();f.response.frames.splice(1,1);await expect(f.run()).rejects.toMatchObject({code:'BROWSER_ACTION_FAILED'});
});
test('a partly executed key sequence cannot certify the application',async()=>{
 const f=fixture();f.response.frames[1].batch!.steps.pop();await expect(f.run()).rejects.toMatchObject({code:'BROWSER_ACTION_FAILED'});
});
