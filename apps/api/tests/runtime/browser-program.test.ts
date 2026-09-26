import { expect, test } from 'vitest';
import { RemoteBrowser } from '../../src/runtime/browser.js';
import { OpenSandboxWorkspace, type SandboxConnection } from '../../src/runtime/workspace.js';

async function fixture(signal?: AbortSignal) {
  let result: unknown = { observation: { id: '22222222-2222-4222-8222-222222222222', sessionId: 'pivloom-11111111-1111-4111-8111-111111111111', url: 'http://127.0.0.1:4173/', tree: '- status "Result"', text: '0\nHistory\n1+2 = 3', truncated: false, refs: {} }, matches: [{ text: '0', value: null }] };
  const connection: SandboxConnection = {
    sandboxId: 'program-fixture', kill: async () => {}, isRunning: async () => true, renew: async () => {}, close: async () => {},
    endpoint: async () => ({ url: 'http://127.0.0.1:4173', headers: {} }), write: async () => {}, read: async () => new Uint8Array(),
    run: async () => ({id: 'command',interrupt:async()=>{},wait:async()=>({exitCode:0,stdoutTail:JSON.stringify({success:true,data:result}),stderrTail:''})}),
  };
  const workspace = new OpenSandboxWorkspace({baseUrl:'http://localhost:18080',apiKey:'fixture',image:'fixture'},{create:async()=>connection});
  const handle = await workspace.create({runId:'program-test',signal:new AbortController().signal});
  const browser = new RemoteBrowser(workspace,handle,undefined,'pivloom-11111111-1111-4111-8111-111111111111',signal);
  return {browser,setResult(value:unknown){result=value;},cleanup:()=>workspace.destroy(handle)};
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
